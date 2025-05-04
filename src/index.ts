import * as PostalMime from 'postal-mime';
import { extractText, getDocumentProxy } from "unpdf";

interface EmailAttachment {
	filename: string;
	content: ArrayBuffer;
	contentType: string;
}

export default {
	async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
		let contentForAi = '';
		const parser = new PostalMime.default({
			attachmentEncoding: 'arraybuffer'
		});
		const rawEmail = new Response(message.raw);
		const email = await parser.parse(await rawEmail.arrayBuffer());

		console.log(email.attachments)

		// ToDo: If attachments contains two files that have invoice and receipt in the filename only process the receipt file
		if (email.attachments.length !== 0) {
			for (const attachment of email.attachments) {
				if (attachment.mimeType === 'application/pdf') {
					const pdf = await extractText(await getDocumentProxy(attachment.content), { mergePages: true });
					console.log(pdf);
					// Remove all perrsonal information like name, email
					// ToDo: Remove card number
					// ToDo: Make this more dynamic
					contentForAi = pdf.text.replace(env.YOUR_NAME, 'Payee Name').replace(env.YOUR_EMAIL, 'Payee Email').replace(env.YOUR_ADDRESS, 'Payee Address').replace(env.YOUR_POSTAL_CODE, 'Payee Postal Code');
				}
			}
		}

		console.log(contentForAi);
	}
} satisfies ExportedHandler<Env>;
