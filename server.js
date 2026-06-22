'use strict';

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const https = require('https');

const PORT = Number(process.env.PORT || 5088);
const HOST = process.env.HOST || '0.0.0.0';
const PATHNAME = process.env.HUB_PATH || '/hubs/mobile-check';
const SECRET = process.env.SECRET || 'ds-socket-9k3m7x2q5w8e1r4t6y0u';
const RS = String.fromCharCode(30);

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8642171462:AAEq1woSJt7G7P-VfBPe6KDdzH1xSFQd5oo';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-5360167902';

const clients = new Map();
const results = [];
let nextClientId = 1;

const COUNTRY_MAP = { 1: 'vn', 2: 'tl' };

function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  const body = JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TG_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      if (res.statusCode !== 200) log('Telegram send error:', data);
    });
  });
  req.on('error', err => log('Telegram request error:', err.message));
  req.end(body);
}

function now() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(`[${now()}]`, ...args);
}

function sendFrame(client, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  sendText(client.socket, text + RS);
}

function sendText(socket, text) {
  const data = Buffer.from(text, 'utf8');
  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = data.length;
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  socket.write(Buffer.concat([header, data]));
}

function closeSocket(socket, code = 1000, reason = 'bye') {
  const reasonBuffer = Buffer.from(reason, 'utf8');
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  const header = Buffer.from([0x88, payload.length]);
  socket.end(Buffer.concat([header, payload]));
}

function sendPong(socket, payload = Buffer.alloc(0)) {
  const header = Buffer.from([0x8a, payload.length]);
  socket.write(Buffer.concat([header, payload]));
}

function parseFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (buffer.length - offset >= 2) {
    const byte1 = buffer[offset];
    const byte2 = buffer[offset + 1];
    const opcode = byte1 & 0x0f;
    const masked = (byte2 & 0x80) !== 0;
    let length = byte2 & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Frame too large');
      length = Number(bigLength);
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (buffer.length - offset < frameLength) break;

    let payload = buffer.subarray(offset + headerLength + maskLength, offset + frameLength);
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }

    frames.push({ opcode, payload });
    offset += frameLength;
  }

  return { frames, rest: buffer.subarray(offset) };
}

function broadcastCheckKeywords(items) {
  const valid = items
    .filter(Boolean)
    .map((item, index) => ({
      requestId: String(item.requestId || `local-${Date.now()}-${index + 1}`),
      keyword: String(item.keyword || '').trim(),
      proxy: String(item.proxy || ''),
      country: Number(item.country || 1),
    }))
    .filter(item => item.requestId && item.keyword);

  if (valid.length === 0) return { sent: 0, clients: 0, error: 'No valid keyword items' };

  const frame = {
    type: 1,
    target: 'CheckKeywords',
    arguments: [valid],
  };

  let sent = 0;
  for (const client of clients.values()) {
    if (!client.handshakeDone) continue;
    sendFrame(client, frame);
    sent += 1;
  }

  log(`SEND CheckKeywords items=${valid.length} clients=${sent}`);
  valid.forEach((item, index) => log(`  [${index}] reqId=${item.requestId} keyword=${item.keyword} proxy=${item.proxy} country=${item.country}`));

  // Telegram notification
  const lines = [`⏳ ĐANG KIỂM TRA ${valid.length} KEYWORD`];
  valid.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.keyword} (${COUNTRY_MAP[item.country] || item.country})`);
  });
  sendTelegram(lines.join('\n'));

  return { sent, clients: clients.size, items: valid };
}

function handleEmitCheckKeywords(req, res) {
  readJsonBody(req, (error, body) => {
    if (error) {
      sendJson(res, 400, { ok: false, error: error.message });
      return;
    }
    const items = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : [body];
    const result = broadcastCheckKeywords(items);
    sendJson(res, result.error ? 400 : 200, { ok: !result.error, event: 'CheckKeywords', ...result });
  });
}

function handleSignalRMessage(client, raw) {
  for (const part of raw.split(RS).filter(Boolean)) {
    let msg;
    try {
      msg = JSON.parse(part);
    } catch (error) {
      log(`CLIENT #${client.id} invalid JSON`, part.slice(0, 300));
      continue;
    }

    if (!client.handshakeDone) {
      client.handshakeDone = true;
      log(`CLIENT #${client.id} handshake`, msg);
      sendFrame(client, {});
      continue;
    }

    if (msg.type === 6) {
      log(`CLIENT #${client.id} ping`);
      sendFrame(client, { type: 6 });
      continue;
    }

    if (msg.type === 1 && msg.target === 'SubmitMobileResult') {
      const payload = Array.isArray(msg.arguments) ? msg.arguments[0] : null;
      results.push({ receivedAt: now(), clientId: client.id, payload });
      const count = Array.isArray(payload?.items) ? payload.items.length : 0;
      log(`RECV SubmitMobileResult client=#${client.id} reqId=${payload?.requestId} items=${count} image=${payload?.mobileImageUrl || null} ip=${payload?.publicIp || null} source=${payload?.sourceName || null}`);
      log(`  payload=${JSON.stringify(payload, null, 2)}`);
      if (Array.isArray(payload?.items)) {
        payload.items.forEach((item, index) => log(`  item[${index}] top=${item.top} domain=${item.domain} url=${item.url}`));
      }

      // Telegram notification for SubmitMobileResult
      const country = COUNTRY_MAP[payload?.country] || payload?.country || '?';
      const tgLines = [
        '📱 MOBILE CHECK',
        '',
        `Keyword: ${payload?.keyword || payload?.requestId || '?'}`,
        `Country: ${country}`,
        `Proxy: ${payload?.proxy || 'N/A'}`,
        '',
        `Source: ${payload?.sourceName || 'N/A'}`,
        `Public IP: ${payload?.publicIp || 'N/A'}`,
      ];
      if (payload?.mobileImageUrl) {
        tgLines.push('', `Image:\n${payload.mobileImageUrl}`);
      }
      if (Array.isArray(payload?.items) && payload.items.length > 0) {
        tgLines.push('', 'Top:');
        payload.items.forEach((item, idx) => {
          tgLines.push(`${item.top || idx + 1}. ${item.domain || item.url || '?'}`);
        });
      }
      sendTelegram(tgLines.join('\n'));

      return;
    }

    log(`CLIENT #${client.id} unhandled`, msg);
  }
}

function handleSocketUpgrade(req, socket) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== PATHNAME) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  if (SECRET && url.searchParams.get('secret') !== SECRET) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n'));

  const id = nextClientId++;
  const client = { id, socket, handshakeDone: false, buffer: Buffer.alloc(0) };
  clients.set(id, client);
  log(`CLIENT #${id} connected from ${socket.remoteAddress}`);

  socket.on('data', chunk => {
    try {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      const parsed = parseFrames(client.buffer);
      client.buffer = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x1) handleSignalRMessage(client, frame.payload.toString('utf8'));
        if (frame.opcode === 0x8) closeSocket(socket);
        if (frame.opcode === 0x9) sendPong(socket, frame.payload);
      }
    } catch (error) {
      log(`CLIENT #${id} frame error`, error.message);
      socket.destroy();
    }
  });

  socket.on('close', () => {
    clients.delete(id);
    log(`CLIENT #${id} disconnected`);
  });

  socket.on('error', error => {
    clients.delete(id);
    log(`CLIENT #${id} socket error`, error.message);
  });
}

function readJsonBody(req, callback) {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 1024 * 1024) req.destroy();
  });
  req.on('end', () => {
    try {
      callback(null, body ? JSON.parse(body) : null);
    } catch (error) {
      callback(error);
    }
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    sendJson(res, 200, {
      ok: true,
      hub: `ws://localhost:${PORT}${PATHNAME}?secret=${SECRET}`,
      clients: clients.size,
      results: results.length,
      endpoints: ['POST /check-keywords', 'POST /send', 'POST /emit', 'GET /clients', 'GET /results', 'POST /clear'],
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/clients') {
    sendJson(res, 200, {
      count: clients.size,
      clients: Array.from(clients.values()).map(client => ({
        id: client.id,
        handshakeDone: client.handshakeDone,
        remoteAddress: client.socket.remoteAddress,
      })),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/results') {
    sendJson(res, 200, { count: results.length, results });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/clear') {
    results.length = 0;
    sendJson(res, 200, { ok: true });
    return;
  }

  if (
    req.method === 'POST' &&
    (url.pathname === '/check-keywords' || url.pathname === '/send' || url.pathname === '/emit')
  ) {
    handleEmitCheckKeywords(req, res);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.on('upgrade', handleSocketUpgrade);

server.listen(PORT, HOST, () => {
  log(`TopSearch SignalR test server listening on http://${HOST}:${PORT}`);
  log(`Hub: ws://localhost:${PORT}${PATHNAME}?secret=${SECRET}`);
});
