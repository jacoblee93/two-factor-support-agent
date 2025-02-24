import { z } from 'zod';
import { tool } from '@langchain/core/tools';

export const technicalSupportTool = tool(
	async () => {
		// Mocked response, could query e.g. a vector database
		return 'You should try turning it off and then on again.';
	},
	{
		name: 'technical_support_manual',
		description: 'Answers technical questions about LangCorp products.',
		schema: z.object({
			product: z.string().describe('The product the user is asking about'),
			problem: z.string().describe('The issue the user is facing'),
		}),
	},
);

export const orderLookupTool = tool(
	async () => {
		// Mocked response, could query e.g. a vector database
		return 'Your order id is 123456.';
	},
	{
		name: 'order_lookup',
		description: 'Answers questions about LangCorp orders.',
		schema: z.object({
			purchaser_name: z.string().describe('The name of the person requesting the information'),
			product: z.string().describe('The product contained in the order'),
		}),
	},
);

export const refundTool = tool(
	async () => {
		// Mocked response, could use e.g. Stripe's API
		return 'Refund successfully processed!';
	},
	{
		name: 'refund_purchase',
		description: 'Refunds a LangCorp purchase. Should only be called after collecting sufficient information.',
		schema: z.object({
			langcorp_order_id: z.string().describe('The LangCorp order id of the purchase'),
			purchaser_name: z.string().describe('The name of the person who would like the refund'),
		}),
	},
);
