export const callTwilio = async (twoFactorCode: string, env: any) => {
	const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
		method: 'POST',
		headers: {
			Authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			To: env.TWILIO_DESTINATION_PHONE_NUMBER,
			From: env.TWILIO_PHONE_NUMBER,
			Body: `[DEMO] Your code is ${twoFactorCode}.`,
		}),
	});

	if (!response.ok) {
		throw new Error('Failed to send SMS via Twilio');
	}
};
