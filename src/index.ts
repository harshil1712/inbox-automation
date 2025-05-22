import * as PostalMime from 'postal-mime';
import { extractText, getDocumentProxy } from "unpdf";
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep, type WorkflowStepConfig } from 'cloudflare:workers';
import { z } from "zod";

// Define the parameters passed to the workflow
interface Params {
	email: ArrayBuffer; // Only raw email is passed now
}

const defaultConfig: WorkflowStepConfig = {
	retries: {
		limit: 1,
		delay: '0.5 seconds',
	},
	timeout: '10 minutes',
};

// Zod schema for PostalMime output (focused on used fields)
const ParsedEmailSchema = z.object({
	messageId: z.string(),
	subject: z.string(),
	from: z.object({ address: z.string().optional(), name: z.string().optional() }),
	text: z.string().optional(),
	html: z.string().optional(),
	attachments: z.array(
		z.object({
			filename: z.string(),
			mimeType: z.string(),
			contentDisposition: z.string().optional(),
			contentId: z.string().optional(),
			content: z.instanceof(ArrayBuffer), // Assuming PostalMime gives ArrayBuffer for attachments
		})
	).default([]),
});

// Zod schema for validating the AI's JSON output
const ExpenseSchema = z.object({
	vendor: z.string(),
	expenseDate: z.string().regex(/^\d{2}-\d{2}-\d{4}$/, "Date must be in DD-MM-YYYY format"),
	amountValue: z.number(),
	currencyCode: z.string().length(3).toUpperCase(),
	category: z.string(),
	description: z.string().optional(),
});

const validCategories = ['Meals', 'Travel', 'Office Supplies', 'Software', 'Hardware', 'Training', 'Telecom', 'Other'];

export class ExpenseAutomationWorkflow extends WorkflowEntrypoint<Env, Params> {
	async run(event: WorkflowEvent<Params>, step: WorkflowStep) {

		// Step 1: Parse the email content and validate with Zod
		const parsedEmailObject = await step.do('parse email', defaultConfig, async () => {
			console.log('Parsing email content');
			const parser = new PostalMime.default({
				attachmentEncoding: 'arraybuffer'
			});;
			const parsed = await parser.parse(event.payload.email);
			console.log('PostalMime raw output:', JSON.stringify(parsed, null, 2)); // For debugging
			return ParsedEmailSchema.parse(parsed); // Validate PostalMime output
		});

		// Step 2: Record initial email processing attempt using data from parsedEmailObject
		const initialEmailRecord = await step.do('recordInitialEmailProcessing', defaultConfig, async () => {
			const emailData = parsedEmailObject; // Correctly using the resolved object
			const messageId = emailData.messageId
			const subject = emailData.subject
			const fromAddress = emailData.from.address

			console.log(`Recording initial processing for messageId: ${messageId}, Subject: ${subject}, From: ${fromAddress}`);
			const stmt = this.env.DB.prepare(
				'INSERT INTO processed_emails (message_id, subject, from_address, is_reimbursable) VALUES (?, ?, ?, ?)'
			);
			const dbResponse = await stmt.bind(
				messageId,
				subject,
				fromAddress,
				false
			).run();
			console.log('Initial email record inserted:', JSON.stringify(dbResponse, null, 2));
			return {
				emailRecordId: dbResponse.meta?.last_row_id,
				success: dbResponse.success
			};
		});

		// Step 3: Prepare data for AI by extracting text from attachments or body
		const parsedContent = step.do('extract text for AI', defaultConfig, async () => {
			let contentForAi = '';
			const emailData = parsedEmailObject; // Use the validated & typed result

			if (emailData.attachments.length > 0) { // Check if array has elements
				for (const attachment of emailData.attachments) {
					if (attachment.mimeType === 'application/pdf') {
						const pdf = await extractText(await getDocumentProxy(attachment.content), { mergePages: true });
						contentForAi = pdf.text.replace(this.env.YOUR_NAME, 'Payee Name').replace(this.env.YOUR_EMAIL, 'Payee Email').replace(this.env.YOUR_ADDRESS, 'Payee Address').replace(this.env.YOUR_POSTAL_CODE, 'Payee Postal Code');
						break;
					}
				}
				return { contentForAi, type: 'attachment' };
			}
			if (emailData.text || emailData.html) {
				contentForAi = emailData.text?.replaceAll(this.env.YOUR_NAME, 'Payee Name').replaceAll(this.env.YOUR_EMAIL, 'Payee Email').replaceAll(this.env.YOUR_ADDRESS, 'Payee Address').replaceAll(this.env.YOUR_POSTAL_CODE, 'Payee Postal Code') || emailData.html?.replaceAll(this.env.YOUR_NAME, 'Payee Name').replaceAll(this.env.YOUR_EMAIL, 'Payee Email').replaceAll(this.env.YOUR_ADDRESS, 'Payee Address').replaceAll(this.env.YOUR_POSTAL_CODE, 'Payee Postal Code') || '';
				return { contentForAi, type: 'body' };
			}
			return { contentForAi: '', type: 'none' };
		});

		// Step 4: Send extracted content to AI for expense parsing
		const aiParsedExpense = step.do('send to AI for expense parsing', defaultConfig, async () => {
			const contentToProcess = await parsedContent;
			if (!contentToProcess.contentForAi) {
				console.log('No content extracted for AI. Skipping AI step.');
				// throw new Error('No content available for AI processing'); // Option to fail step
			}
			const prompt = `You are a personal assistant. You help me with logging my expenses. You receive the extracted textual data from an email/attachment.
Based on this data, provide the following output in JSON format:
- Vendor: Company Name and/or the service to pay for.
- Expense Date: Date of invoice or expense (DD-MM-YYYY).
- Amount Value: The final numeric amount to be paid.
- Currency Code: The 3-letter currency code (e.g., USD, EUR, CAD).
- Category: Classify the expense into one of the following categories: ${validCategories.join(', ')}. If unsure, use 'Other'.
- Description: A brief description of the expense (e.g., "Lunch with client", "Software subscription").

Here's the content: ${contentToProcess?.contentForAi}

The output should be a single JSON object matching this schema:
{
  "vendor": "string",
  "expenseDate": "string (DD-MM-YYYY)",
  "amountValue": number,
  "currencyCode": "string (3-letter code)",
  "category": "string (from provided list)",
  "description": "string (optional, default to empty string if not found)"
}
Only return the JSON object. Ensure description is an empty string if not applicable, rather than null or undefined.`;

			const { response } = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
				prompt: prompt,
				response_format: {
					type: 'json_schema',
					json_schema: {
						type: 'object',
						properties: {
							vendor: { type: 'string', description: "Company Name or service provider." },
							expenseDate: { type: 'string', description: "Date of invoice/expense in DD-MM-YYYY format." },
							amountValue: { type: 'number', description: "The numeric final amount to be paid." },
							currencyCode: { type: 'string', description: "The 3-letter currency code (e.g., USD, EUR)." },
							category: { type: 'string', enum: validCategories, description: `Expense category. Must be one of: ${validCategories.join(', ')}.` },
							description: { type: 'string', description: "A brief description of the expense." }
						},
						required: ["vendor", "expenseDate", "amountValue", "currencyCode", "category", "description"]
					}
				}
			});
			console.log('AI Raw Response:', response);
			const parsedAiData = ExpenseSchema.parse(response);
			console.log('Parsed AI Response:', JSON.stringify(parsedAiData, null, 2));
			return parsedAiData;
		});

		// Step 5: Insert parsed expense data into the expenses table
		const expenseInsertResult = await step.do('insertExpenseRecord', defaultConfig, async () => {
			const aiData = await aiParsedExpense;
			const emailDbRecord = initialEmailRecord;

			console.log('Inserting expense data into the database:')

			if (!emailDbRecord.emailRecordId) {
				console.error('Cannot insert expense: emailRecordId is missing.');
				throw new Error('Failed to get emailRecordId for expense insertion.');
			}

			const [day, month, year] = aiData.expenseDate.split('-');
			const formattedDate = `${year}-${month}-${day}`;

			console.log('Attempting to insert expense data into the database:');
			console.log(JSON.stringify(aiData, null, 2));

			const stmt = this.env.DB.prepare(
				'INSERT INTO expenses (email_id, amount, currency, description, expense_date, category, vendor) VALUES (?, ?, ?, ?, ?, ?, ?)'
			);
			const dbResponse = await stmt.bind(
				emailDbRecord.emailRecordId,
				aiData.amountValue,
				aiData.currencyCode,
				aiData.description,
				formattedDate,
				aiData.category,
				aiData.vendor
			).run();

			console.log('Expense data inserted successfully:', JSON.stringify(dbResponse, null, 2));
			return {
				success: dbResponse.success,
				meta: {
					last_row_id: dbResponse.meta?.last_row_id,
					changes: dbResponse.meta?.changes
				}
			};
		});

		// Step 6: Finalize email processing status (mark as 'processed')
		const finalizeStatus = step.do('finalizeEmailProcessingStatus', defaultConfig, async () => {
			const emailDbRecord = initialEmailRecord;
			if (!emailDbRecord.emailRecordId) {
				console.error('Cannot finalize email status: emailRecordId is missing.');
				return { success: false, error: 'Missing emailRecordId' };
			}

			console.log(`Finalizing email processing status for emailRecordId: ${emailDbRecord.emailRecordId}`);
			const stmt = this.env.DB.prepare(
				'UPDATE processed_emails SET status = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?'
			);
			const dbResponse = await stmt.bind('processed', emailDbRecord.emailRecordId).run();
			console.log('Email status finalized to processed:', JSON.stringify(dbResponse, null, 2));
			return {
				success: dbResponse.success,
				changes: dbResponse.meta?.changes
			};
		});

		// Await the final step to ensure the workflow completes it.
		await finalizeStatus;
	}
}

export default {
	async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
		const workflowId = crypto.randomUUID();
		const rawEmail = await new Response(message.raw).arrayBuffer();

		console.log(`Email received. From: ${message.from}, Subject: "${message.headers.get('Subject') || ''}". Creating workflow ID: ${workflowId}`);

		env.EXPENSE_AUTOMATION.create({
			id: workflowId,
			params: {
				email: rawEmail,
			}
		});
	}
} satisfies ExportedHandler<Env>;
