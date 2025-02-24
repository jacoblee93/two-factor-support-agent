import { ChatAnthropic } from "@langchain/anthropic";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableConfig } from "@langchain/core/runnables";
import { StructuredTool } from "@langchain/core/tools";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import { StateGraph, messagesStateReducer } from "@langchain/langgraph";
import { Client } from "langsmith";
import { traceable } from "langsmith/traceable";

import { CloudflareD1Saver } from "./lib/checkpointer.js";

import { technicalSupportTool, orderLookupTool, refundTool } from "./lib/tools";
import { callTwilio } from "./lib/twilio";

interface Env {
  ANTHROPIC_API_KEY: string;
  LANGCHAIN_TRACING_V2: string;
  LANGCHAIN_API_KEY: string;
  LANGCHAIN_PROJECT: string;
  DB: D1Database;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER: string;
  TWILIO_DESTINATION_PHONE_NUMBER: string;
}

// Define the state interface
interface AgentState {
  messages: BaseMessage[];
  auth_state?: "authorizing" | "authed";
  generated_two_factor_code?: string;
  provided_two_factor_code?: string;
  authorization_failure_count?: number;
}

const graphState = {
  messages: {
    reducer: messagesStateReducer,
  },
  auth_state: null,
  generated_two_factor_code: null,
  provided_two_factor_code: null,
  authorization_failure_count: null,
}

const READONLY_TOOLS_BY_NAME: Record<string, StructuredTool> = {
  technical_support_manual: technicalSupportTool,
  order_lookup: orderLookupTool,
};

const AUTHORIZED_TOOLS_BY_NAME: Record<string, StructuredTool> = {
  refund_purchase: refundTool,
};

/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.toml`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/") {
      return new Response("Not Found", { status: 404 });
    }
    const queryParams = url.searchParams;
    const question = queryParams.get("question");
    const isResuming = queryParams.get("two_factor_code") != null;
    const threadId = queryParams.get("thread_id");
    if (question == null && !isResuming) {
      throw new Error(`You must provide a "question" parameter if you are not resuming a conversation.`)
    }
    if (threadId == null) {
      throw new Error(`You must provide a "thread_id" parameter.`);
    }

    const model = new ChatAnthropic({
      // model: "claude-3-haiku-20240307",
      model: "claude-3-5-sonnet-20240620",
      temperature: 0,
      apiKey: env.ANTHROPIC_API_KEY,
    });

    const tools = [technicalSupportTool, orderLookupTool, refundTool];
    const modelWithTools = model.bindTools(tools);

    const supportAgent = async (state: AgentState) => {
      const SYSTEM_TEMPLATE =
        `You are Polly, an expert human (not an AI assistant!) support agent for LangCorp, a company that sells computers.
You can chat with customers and help them with basic questions, but you do not know anything innately about billing or technical issues.
Instead, you should use the data sources available to resolve the user's problem in a satisfactory way.`;
    
      const prompt = ChatPromptTemplate.fromMessages([
        ["system", SYSTEM_TEMPLATE],
        ["placeholder", "{messages}"],
      ]);

      const chain = prompt.pipe(modelWithTools);

      const response = await chain.invoke({ messages: state.messages });

      return { messages: [response] };
    };

    const shouldContinue = async (state: AgentState) => {
      const messages = state.messages;
      const lastMessage = messages[messages.length - 1] as AIMessage;
      // For simplicity, handle single tool calls only
      const toolCall = lastMessage.tool_calls?.[0];

      if (toolCall === undefined) {
        return "__end__";
      } else if (AUTHORIZED_TOOLS_BY_NAME[toolCall.name] !== undefined) {
        return "request_authorization";
      } else if (READONLY_TOOLS_BY_NAME[toolCall.name] !== undefined) {
        return "invoke_readonly_tools";
      } else {
        throw new Error("Invalid tool call generated.");
      }
    };
    
    const requestAuthorization = async (state: AgentState) => {
      const hadPreviousAttempt = state.auth_state === "authorizing";
      const twoFactorCode = Math.floor(1000 + Math.random() * 9000).toString();

      try {
        // Wrap in "traceable" for LangSmith
        const sendSms = traceable(callTwilio, { run_type: "tool", name: "Twilio SMS" });
        await sendSms(twoFactorCode, env);
      } catch (e) {
        console.log(e);
      }

      return {
        auth_state: "authorizing",
        // Random 4 digit number
        generated_two_factor_code: twoFactorCode,
        provided_two_factor_code: undefined,
        authorization_failure_count: hadPreviousAttempt ? (state.authorization_failure_count ?? 0) + 1 : undefined,
      };
    };

    const confirmAuthorization = async (state: AgentState) => {
      return {
        auth_state: state.generated_two_factor_code === state.provided_two_factor_code ? "authed" : "authorizing",
        provided_two_factor_code: undefined,
        generated_two_factor_code: undefined,
      };
    }

    const shouldExecuteAuthorizedTool = async (state: AgentState) => {
      if (state.auth_state === "authed") {
        return "invoke_authorized_tools";
      } else {
        return "request_authorization";
      }
    }

    const executeReadonlyTools = async (state: AgentState) => {
      const messages = state.messages;
      const lastMessage = messages[messages.length - 1] as AIMessage;
      // For simplicity, handle single tool calls only
      const toolCall = lastMessage.tool_calls![0];
      const toolResponse = await READONLY_TOOLS_BY_NAME[toolCall.name].invoke(toolCall);
      return { messages: [toolResponse] };
    };

    const executeAuthorizedTools = async (state: AgentState) => {
      const messages = state.messages;
      const lastMessage = messages[messages.length - 1] as AIMessage;
      // For simplicity, handle single tool calls only
      const toolCall = lastMessage.tool_calls![0];
      const toolResponse = await AUTHORIZED_TOOLS_BY_NAME[toolCall.name].invoke(toolCall);
      return {
        messages: [toolResponse],
        auth_state: undefined,
        authorization_failure_count: 0,
      };
    };

    const checkpointer = new CloudflareD1Saver({ db: env.DB });

    const app = new StateGraph<AgentState>({ channels: graphState })
      .addNode("support_agent", supportAgent)
      .addNode("request_authorization", requestAuthorization)
      .addNode("confirm_authorization", confirmAuthorization)
      .addNode("invoke_authorized_tools", executeAuthorizedTools)
      .addNode("invoke_readonly_tools", executeReadonlyTools)
      .addEdge("__start__", "support_agent")
      .addConditionalEdges("support_agent", shouldContinue)
      .addEdge("request_authorization", "confirm_authorization")
      .addConditionalEdges("confirm_authorization", shouldExecuteAuthorizedTool)
      .addEdge("invoke_authorized_tools", "support_agent")
      .addEdge("invoke_readonly_tools", "support_agent")
      .compile({
        checkpointer,
        interruptBefore: ["confirm_authorization"],
      });

    const config: RunnableConfig = {
      configurable: { thread_id: threadId },
      runName: "Customer Support Agent",
    };
    if (
      queryParams.get("two_factor_code") != null
    ) {
      await app.updateState(
        config,
        {
          provided_two_factor_code: queryParams.get("two_factor_code"),
        },
      );
    }

    if (env.LANGCHAIN_TRACING_V2 === "true") {
      const tracer = new LangChainTracer({
        client: new Client({
          apiKey: env.LANGCHAIN_API_KEY,
        }),
        projectName: env.LANGCHAIN_PROJECT,
      });
      config.callbacks = [tracer];
    }

    const endState = await app.invoke(
      isResuming ? null : { messages: [new HumanMessage(question!)] },
      config
    );
    
    if (endState.auth_state === "authorizing") {
      return new Response([
        "To confirm it's really you, we've texted you a code.",
        "Please re-enter the code here once you receive it.",
        `You've had ${endState.authorization_failure_count ?? 0} failed attempts.`,
      ].join("\n\n"));
    } else {
      return new Response(endState.messages[endState.messages.length - 1].content);
    }
  },
} satisfies ExportedHandler<Env>;
