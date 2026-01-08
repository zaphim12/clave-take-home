import { NextResponse } from "next/server";
import Groq from "groq-sdk";
import {
  schemaAsString,
  LLMResponseSchema,
} from "@/lib/queryIntentSchema";
import { executeQueryIntent } from "@/lib/queryBuilder";

const client = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export async function POST(req: Request) {
  const { prompt } = await req.json();

  const systemPrompt = `
You are an analytics query interpreter for a restaurant dashboard.

Return ONLY valid JSON with no markdown formatting, code blocks, or extra text.
Do not wrap the JSON in \`\`\`json or any other formatting.
Do not include a date_range unless the user has explicitly asked for a date restriction.
For the purposes of this task, assume today's date is ${new Date().toISOString().split('T')[0]}.

Return ONLY valid JSON that matches this schema exactly:

${schemaAsString()}

Rules:
- Do not include extra fields
- Do not include explanations outside JSON
- Use reasonable defaults when the user is ambiguous
`;

  const completion = await client.chat.completions.create({
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
  });

  let content = completion.choices[0].message.content;
  if (!content) {
    return NextResponse.json({ error: "Empty response" }, { status: 500 });
  }

  // The LLM is pretty good at responding with only JSON, but just in case let's try to remove any markdown wrapper
  content = content.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  const parsedJson = JSON.parse(content);

  const validated = LLMResponseSchema.parse(parsedJson);

  // Execute the query against Supabase to get real data
  try {
    const chartData = await executeQueryIntent(validated.intent);
    
    return NextResponse.json({
      ...validated,
      data: chartData,
    });
  } catch (error) {
    console.error("Failed to execute query:", error);
    // Return the response with mock data on query failure
    return NextResponse.json(validated);
  }
}
