import assert from "assert";
import { extractValidJsonObject } from "../src/json_extractor.js";

console.log("[TEST] Testing robust balanced brace JSON extraction...");

// 1. Multiple code blocks and conversational text
const sampleWithPreambleAndExamples = `
Here is an example config:
\`\`\`json
{ "example": true, "notes": "ignore this" }
\`\`\`
Now here is the generated requirement blueprint:
\`\`\`json
{
  "requirementSlots": [
    { "key": "target", "label": "Build Mode", "type": "choice" }
  ]
}
\`\`\`
Hope this helps!
`;

const parsed1 = extractValidJsonObject(sampleWithPreambleAndExamples);
assert.deepStrictEqual(parsed1, { example: true, notes: "ignore this" }, "First code block correctly parsed");

// 2. Pure balanced braces with conversational preface and suffix without code fence
const sampleConversationalBraces = `
Sure, here is your result:
{
  "name": "my-tool",
  "nested": {
    "count": 42,
    "quote": "hello \\"world\\" {brace in string}"
  }
}
Note that the above was generated automatically.
`;

const parsed2 = extractValidJsonObject(sampleConversationalBraces);
assert.strictEqual(parsed2.name, "my-tool");
assert.strictEqual(parsed2.nested.count, 42);
assert.strictEqual(parsed2.nested.quote, 'hello "world" {brace in string}');

console.log("[PASS] All balanced JSON extractor tests passed!");
