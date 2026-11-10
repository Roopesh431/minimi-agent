
import dotenv from "dotenv";
import { resolve } from "node:path";
import { createChatCompletion } from "./src/services/llm/llmService";

dotenv.config({
  path: resolve(process.cwd(), "server/.env")
});

async function testLLM() {
  try {
    const result = await createChatCompletion({
      messages: [
        {
          role: "system",
          content: "You are Minimi, a helpful AI assistant. Be concise."
        },
        {
          role: "user",
          content: "Reply with exactly: Minimi AI connection successful."
        }
      ]
    });

    console.log("\nGroq connection successful!");
    console.log("Model:", result.model);
    console.log("Response:", result.message.content);
    console.log("Usage:", result.usage);
  } catch (error) {
    console.error("\nGroq connection failed:");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

testLLM();
