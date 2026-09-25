import { createServer } from 'node:http';
/** Synthetic test-only endpoint. It never executes tools or performs inference. */
export function modelFixture() {
  let count = 0;
  return createServer((req, res) => {
    if (req.url === '/count') {
      res.end(String(count));
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      count++;
      const value = JSON.parse(body);
      if (value.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          'data: ' +
            JSON.stringify({
              choices: [{ index: 0, delta: { content: 'redai_probe_ok' }, finish_reason: null }],
            }) +
            '\n\ndata: ' +
            JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
            '\n\ndata: [DONE]\n\n',
        );
      } else {
        const tools = value.tools
          ? [
              {
                id: 'probe',
                type: 'function',
                function: { name: 'redai_probe', arguments: '{"ok":true}' },
              },
            ]
          : undefined;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [
              {
                index: 0,
                finish_reason: tools ? 'tool_calls' : 'stop',
                message: {
                  role: 'assistant',
                  content: tools ? null : value.response_format ? '{"ok":true}' : 'redai_probe_ok',
                  ...(tools ? { tool_calls: tools } : {}),
                },
              },
            ],
          }),
        );
      }
    });
  });
}
