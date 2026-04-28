'use strict';

const http = require('http');
const { getProxyUrl, getProxyRequestHeaders } = require('../proxy/server/settings');

function _request(method, path, body) {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) {
    return Promise.reject(new Error('Proxy not running (no url in settings.json)'));
  }

  const url = new URL(path, proxyUrl);

  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const headers = Object.assign({
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    }, getProxyRequestHeaders());
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + (url.search || ''),
        method,
        headers,
        timeout: 10_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve({ raw });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Proxy request timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function mailboxTransportSend(message) {
  const type = message.message_type || message.type || 'unknown';
  const payload = message.payload || message;
  return _request('POST', '/mailbox/send', { type, payload });
}

function mailboxTransportReceive(opts = {}) {
  return _request('POST', '/mailbox/poll', {
    type: opts.type || null,
    channel: opts.channel || null,
    limit: opts.limit || 20,
  }).then((data) => data.messages || []);
}

function mailboxTransportList(opts = {}) {
  const type = opts.type || 'hub_event';
  return _request('GET', `/mailbox/list?type=${encodeURIComponent(type)}&limit=${opts.limit || 20}`)
    .then((data) => data.messages || []);
}

const mailboxTransport = {
  send: mailboxTransportSend,
  receive: mailboxTransportReceive,
  list: mailboxTransportList,
};

function registerMailboxTransport() {
  const { registerTransport } = require('./a2aProtocol');
  registerTransport('mailbox', mailboxTransport);
}

module.exports = { mailboxTransport, registerMailboxTransport };
