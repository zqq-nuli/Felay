import { startApiProxy, getProxyEnvConfig } from "../packages/cli/dist/apiProxy.js";
import http from "node:http";

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, msg) {
  if (!condition) {
    testsFailed++;
    throw new Error("ASSERTION FAILED: " + msg);
  }
}

// ── Test 1: getProxyEnvConfig ──
console.log("=== Test 1: getProxyEnvConfig ===");
const claude = getProxyEnvConfig("claude");
const codex = getProxyEnvConfig("codex");
const vim = getProxyEnvConfig("vim");
const claudeCmd = getProxyEnvConfig("claude.cmd");
const codexExe = getProxyEnvConfig("C:\\Users\\bin\\codex.exe");

assert(claude?.provider === "anthropic", "claude should be anthropic");
assert(claude?.envVar === "ANTHROPIC_BASE_URL", "claude envVar");
assert(codex?.provider === "openai", "codex should be openai");
assert(codex?.envVar === "OPENAI_BASE_URL", "codex envVar");
assert(vim === null, "vim should be null");
assert(claudeCmd?.provider === "anthropic", "claude.cmd should be anthropic");
assert(codexExe?.provider === "openai", "codex.exe path should be openai");
console.log("PASSED\n");
testsPassed++;

// ── Test 2: Anthropic SSE proxy + assembly ──
console.log("=== Test 2: Anthropic SSE proxy + assembly ===");
{
  const mockUpstream = http.createServer((req, res) => {
    if (req.url === "/v1/messages") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const events = [
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_test\"}}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"from proxy!"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      let i = 0;
      const send = () => {
        if (i < events.length) { res.write(events[i]); i++; setTimeout(send, 10); }
        else { res.end(); }
      };
      send();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }
  });

  await new Promise(resolve => mockUpstream.listen(0, "127.0.0.1", resolve));
  const mockPort = mockUpstream.address().port;

  let assembledMsg = null;
  const proxy = await startApiProxy(
    { upstreamBaseUrl: `http://127.0.0.1:${mockPort}`, provider: "anthropic" },
    (msg) => { assembledMsg = msg; }
  );

  // SSE request
  const sseResp = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-3", messages: [] }),
  });
  const sseBody = await sseResp.text();
  assert(sseBody.includes("message_stop"), "Client should receive full SSE stream");

  await new Promise(r => setTimeout(r, 100));
  assert(assembledMsg !== null, "Should have assembled message");
  assert(assembledMsg.provider === "anthropic", "Provider should be anthropic");
  assert(assembledMsg.stopReason === "end_turn", "Stop reason should be end_turn");
  assert(assembledMsg.textContent === "Hello from proxy!", "Text should be 'Hello from proxy!', got: " + assembledMsg.textContent);
  assert(assembledMsg.completedAt, "Should have completedAt");

  // Non-SSE request
  assembledMsg = null;
  const jsonResp = await fetch(`http://127.0.0.1:${proxy.port}/v1/other`);
  const jsonBody = await jsonResp.json();
  assert(jsonBody.ok === true, "Non-SSE should proxy correctly");
  assert(assembledMsg === null, "Should not assemble non-SSE");

  await proxy.close();
  mockUpstream.close();
  console.log("PASSED\n");
  testsPassed++;
}

// ── Test 3: CRLF line endings ──
console.log("=== Test 3: CRLF line endings ===");
{
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("event: content_block_start\r\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\r\n\r\n");
    res.write("event: content_block_delta\r\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"CRLF works\"}}\r\n\r\n");
    res.write("event: content_block_stop\r\ndata: {\"type\":\"content_block_stop\",\"index\":0}\r\n\r\n");
    res.write("event: message_delta\r\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\r\n\r\n");
    res.write("event: message_stop\r\ndata: {\"type\":\"message_stop\"}\r\n\r\n");
    res.end();
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

  let msg = null;
  const proxy = await startApiProxy(
    { upstreamBaseUrl: `http://127.0.0.1:${server.address().port}`, provider: "anthropic" },
    (m) => { msg = m; }
  );

  await fetch(`http://127.0.0.1:${proxy.port}/test`, { method: "POST", body: "{}" });
  await new Promise(r => setTimeout(r, 100));

  assert(msg !== null, "CRLF: Should have assembled message");
  assert(msg.textContent === "CRLF works", "CRLF: Text should be 'CRLF works', got: " + msg.textContent);
  assert(msg.stopReason === "end_turn", "CRLF: Stop reason should be end_turn");

  await proxy.close();
  server.close();
  console.log("PASSED\n");
  testsPassed++;
}

// ── Test 4: OpenAI format ──
console.log("=== Test 4: OpenAI format ===");
{
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"Open"},"index":0}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"AI works"},"index":0}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

  let msg = null;
  const proxy = await startApiProxy(
    { upstreamBaseUrl: `http://127.0.0.1:${server.address().port}`, provider: "openai" },
    (m) => { msg = m; }
  );

  await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: "POST", body: "{}" });
  await new Promise(r => setTimeout(r, 100));

  assert(msg !== null, "OpenAI: Should have assembled message");
  assert(msg.provider === "openai", "OpenAI: Provider should be openai");
  assert(msg.stopReason === "stop", "OpenAI: Stop reason should be stop");
  assert(msg.textContent === "OpenAI works", "OpenAI: Text should be 'OpenAI works', got: " + msg.textContent);

  await proxy.close();
  server.close();
  console.log("PASSED\n");
  testsPassed++;
}

// ── Test 5: Anthropic tool_use ──
console.log("=== Test 5: Anthropic tool_use ===");
{
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me search."}}\n\n');
    res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
    res.write('event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"web_search","input":{}}}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":"}}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"hello\\"}"}}\n\n');
    res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n');
    res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n');
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    res.end();
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

  let msg = null;
  const proxy = await startApiProxy(
    { upstreamBaseUrl: `http://127.0.0.1:${server.address().port}`, provider: "anthropic" },
    (m) => { msg = m; }
  );

  await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST", body: "{}" });
  await new Promise(r => setTimeout(r, 100));

  assert(msg !== null, "Tool: Should have assembled message");
  assert(msg.stopReason === "tool_use", "Tool: Stop reason should be tool_use");
  assert(msg.textContent === "Let me search.", "Tool: Text mismatch");
  assert(msg.toolUseBlocks?.length === 1, "Tool: Should have 1 tool block");
  assert(msg.toolUseBlocks[0].name === "web_search", "Tool: Name should be web_search");
  assert(msg.toolUseBlocks[0].input === '{"query":"hello"}', "Tool: Input mismatch: " + msg.toolUseBlocks[0].input);

  await proxy.close();
  server.close();
  console.log("PASSED\n");
  testsPassed++;
}

// ── Test 6: OpenAI tool_calls ──
console.log("=== Test 6: OpenAI tool_calls ===");
{
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"get_weather","arguments":""}}]},"index":0}]}\n\n');
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Tokyo\\"}"}}]},"index":0}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

  let msg = null;
  const proxy = await startApiProxy(
    { upstreamBaseUrl: `http://127.0.0.1:${server.address().port}`, provider: "openai" },
    (m) => { msg = m; }
  );

  await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: "POST", body: "{}" });
  await new Promise(r => setTimeout(r, 100));

  assert(msg !== null, "OAI Tool: Should have assembled message");
  assert(msg.stopReason === "tool_calls", "OAI Tool: Stop reason should be tool_calls");
  assert(msg.textContent === "", "OAI Tool: Text should be empty");
  assert(msg.toolUseBlocks?.length === 1, "OAI Tool: Should have 1 tool block");
  assert(msg.toolUseBlocks[0].name === "get_weather", "OAI Tool: Name mismatch");
  assert(msg.toolUseBlocks[0].input === '{"city":"Tokyo"}', "OAI Tool: Input mismatch: " + msg.toolUseBlocks[0].input);

  await proxy.close();
  server.close();
  console.log("PASSED\n");
  testsPassed++;
}

// ── Test 7: OpenAI CRLF [DONE] ──
console.log("=== Test 7: OpenAI CRLF [DONE] ===");
{
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    // CRLF line endings with OpenAI format
    res.write("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"index\":0}]}\r\n\r\n");
    res.write("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\",\"index\":0}]}\r\n\r\n");
    res.write("data: [DONE]\r\n\r\n");
    res.end();
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

  let msg = null;
  const proxy = await startApiProxy(
    { upstreamBaseUrl: `http://127.0.0.1:${server.address().port}`, provider: "openai" },
    (m) => { msg = m; }
  );

  await fetch(`http://127.0.0.1:${proxy.port}/test`, { method: "POST", body: "{}" });
  await new Promise(r => setTimeout(r, 100));

  assert(msg !== null, "CRLF DONE: Should have assembled message (this was the bug we fixed!)");
  assert(msg.textContent === "hi", "CRLF DONE: Text mismatch");
  assert(msg.stopReason === "stop", "CRLF DONE: Stop reason mismatch");

  await proxy.close();
  server.close();
  console.log("PASSED\n");
  testsPassed++;
}

// ── Test 8: Headers forwarded correctly ──
console.log("=== Test 8: Header forwarding ===");
{
  let receivedHeaders = null;
  const server = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    res.writeHead(200, { "Content-Type": "application/json", "X-Custom": "response-header" });
    res.end('{"ok":true}');
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

  const proxy = await startApiProxy(
    { upstreamBaseUrl: `http://127.0.0.1:${server.address().port}`, provider: "anthropic" },
    () => {}
  );

  const resp = await fetch(`http://127.0.0.1:${proxy.port}/test`, {
    method: "POST",
    headers: {
      "Authorization": "Bearer sk-test-key",
      "X-Custom-Header": "test-value",
      "Content-Type": "application/json",
    },
    body: '{}',
  });

  assert(receivedHeaders["authorization"] === "Bearer sk-test-key", "Auth header should be forwarded");
  assert(receivedHeaders["x-custom-header"] === "test-value", "Custom header should be forwarded");
  assert(receivedHeaders["host"] === `127.0.0.1:${server.address().port}`, "Host should be rewritten to upstream");
  assert(resp.headers.get("x-custom") === "response-header", "Response headers should be forwarded");

  await proxy.close();
  server.close();
  console.log("PASSED\n");
  testsPassed++;
}

console.log("========================================");
console.log(`  ${testsPassed} PASSED, ${testsFailed} FAILED`);
console.log("========================================");
process.exit(testsFailed > 0 ? 1 : 0);
