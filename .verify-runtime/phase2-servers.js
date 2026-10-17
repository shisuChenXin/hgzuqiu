'use strict';

const http = require('http');
const crypto = require('crypto');

const SENSITIVE_PARAM_KEYS = /^(pass(word)?|passcode|pwd|token|secret)$/i;

function sanitizeParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    out[key] = SENSITIVE_PARAM_KEYS.test(key) ? '<redacted>' : value;
  }
  return out;
}

function parseParams(req, body) {
  const parsed = new URLSearchParams(body || '');
  const url = new URL(req.url, 'http://127.0.0.1');
  for (const [key, value] of url.searchParams.entries()) {
    if (!parsed.has(key)) parsed.append(key, value);
  }
  return Object.fromEntries(parsed.entries());
}

function appendJsonl(file, value) {
  require('fs').appendFileSync(file, JSON.stringify(value) + '\n', 'utf8');
}

function createMockUpstream({ host, port, ticketPrefixes, logFile }) {
  const events = [];
  let ticketIndex = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const params = parseParams(req, body);
      const action = String(params.p || '');
      const event = {
        at: new Date().toISOString(),
        remote_address: req.socket.remoteAddress || '',
        method: req.method,
        url: req.url,
        action,
        content_type: req.headers['content-type'] || '',
        params: sanitizeParams(params),
      };

      let status = 200;
      let contentType = 'application/xml; charset=utf-8';
      let responseBody = '';

      if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        contentType = 'text/html; charset=utf-8';
        responseBody = `<html><script>top.ver='phase2-local-mock'</script></html>`;
      } else if (action === 'chk_login') {
        responseBody = '<serverresponse><msg>100</msg><uid>phase2-mock-uid</uid></serverresponse>';
      } else if (action === 'FT_order_view') {
        responseBody = '<serverresponse><code>501</code><ioratio>1.90</ioratio><ratio>1900</ratio><con>1</con><spread>1</spread></serverresponse>';
      } else if (action === 'FT_bet') {
        const prefix = ticketPrefixes[Math.min(ticketIndex, ticketPrefixes.length - 1)] || 'UI-LIVE-UNEXPECTED';
        ticketIndex += 1;
        const ticketId = `${prefix}-${String(ticketIndex).padStart(3, '0')}`;
        event.ticket_id = ticketId;
        responseBody = `<serverresponse><code>560</code><ticket_id>${ticketId}</ticket_id><ioratio>1.90</ioratio><gold>80</gold></serverresponse>`;
      } else if (action === 'get_today_wagers') {
        contentType = 'application/json; charset=utf-8';
        responseBody = JSON.stringify({ wagers: [] });
      } else {
        status = 500;
        contentType = 'text/plain; charset=utf-8';
        responseBody = `unrecognized phase2 mock action: ${action || '<empty>'}`;
      }

      event.response_status = status;
      events.push(event);
      appendJsonl(logFile, event);
      res.writeHead(status, {
        'content-type': contentType,
        'cache-control': 'no-store',
      });
      res.end(responseBody);
    });
    req.on('error', error => {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`mock request error: ${error.message}`);
    });
  });

  return {
    server,
    events,
    get ftBetEvents() {
      return events.filter(event => event.action === 'FT_bet');
    },
  };
}

function encodeWsFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function createWsFixtureServer({ host, port, token, matches, logFile }) {
  const events = [];
  const sockets = new Set();

  const httpServer = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('phase2 WS fixture');
  });

  function record(direction, payload) {
    const event = {
      at: new Date().toISOString(),
      direction,
      remote_address: payload.remote_address || '',
      type: payload.type || '',
      data: payload.data || null,
    };
    events.push(event);
    appendJsonl(logFile, event);
  }

  function sendJson(socket, type, data, remoteAddress) {
    const text = JSON.stringify({ type, data });
    socket.write(encodeWsFrame(text));
    record('sent', { remote_address: remoteAddress, type, data });
  }

  function handleFrame(socket, text, remoteAddress) {
    let message;
    try {
      message = JSON.parse(text.toString('utf8'));
    } catch (error) {
      sendJson(socket, 'error', { message: `invalid JSON: ${error.message}` }, remoteAddress);
      return;
    }
    record('received', {
      remote_address: remoteAddress,
      type: message.type,
      data: {
        ...(message.data || {}),
        token: message.type === 'auth' ? '<redacted>' : message.data?.token,
      },
    });

    if (message.type === 'auth') {
      if (String(message.data?.token || '') !== token) {
        sendJson(socket, 'error', { message: '认证失败' }, remoteAddress);
        socket.end();
        return;
      }
      sendJson(socket, 'heartbeat', {
        message: '认证成功',
        server_time: new Date().toISOString(),
      }, remoteAddress);
      return;
    }

    if (message.type === 'subscribe') {
      const showTypes = Array.isArray(message.data?.showTypes) ? message.data.showTypes : [];
      for (const showType of showTypes) {
        sendJson(socket, 'full_data', {
          showType,
          matches: showType === 'live' ? matches : [],
        }, remoteAddress);
      }
      return;
    }

    sendJson(socket, 'error', { message: `unsupported type: ${message.type || '<empty>'}` }, remoteAddress);
  }

  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || !req.url.startsWith('/ws')) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    const remoteAddress = socket.remoteAddress || '';

    const processBuffer = () => {
      while (buffer.length >= 2) {
        const first = buffer[0];
        const second = buffer[1];
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < offset + 2) return;
          length = buffer.readUInt16BE(offset);
          offset += 2;
        } else if (length === 127) {
          if (buffer.length < offset + 8) return;
          const bigLength = buffer.readBigUInt64BE(offset);
          if (bigLength > BigInt(1024 * 1024)) throw new Error('WS frame too large');
          length = Number(bigLength);
          offset += 8;
        }
        const maskLength = masked ? 4 : 0;
        if (buffer.length < offset + maskLength + length) return;
        let mask;
        if (masked) {
          mask = buffer.subarray(offset, offset + 4);
          offset += 4;
        }
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (mask) {
          for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
        }
        buffer = buffer.subarray(offset + length);
        if (!fin) continue;
        if (opcode === 0x1 || opcode === 0x2) {
          handleFrame(socket, payload, remoteAddress);
        } else if (opcode === 0x8) {
          socket.end(Buffer.from([0x88, 0x00]));
          sockets.delete(socket);
          return;
        } else if (opcode === 0x9) {
          socket.write(Buffer.from([0x8a, 0x00]));
        }
      }
    };

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      processBuffer();
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });

  return { server: httpServer, events, sockets };
}

module.exports = {
  createMockUpstream,
  createWsFixtureServer,
  sanitizeParams,
};
