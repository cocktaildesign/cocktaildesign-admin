// Local fixtures only: no SMTP server or application environment is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { Readable } = require('node:stream');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const provider = require('@strapi/provider-email-sendmail');
const { createRequire } = require('node:module');
const providerRequire = createRequire(require.resolve('@strapi/provider-email-sendmail'));
const transferRequire = createRequire(require.resolve('@strapi/data-transfer'));
const editorRequire = createRequire(require.resolve('@strapi/content-manager/package.json'));

test('Strapi mail provider sends headers and a memory attachment through loopback SMTP', async () => {
  const recipients = [], messages = [], sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8'); socket.write('220 local-fixture ESMTP\r\n');
    let pending = '', data = false, message = [];
    socket.on('data', chunk => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 2);
        if (data) {
          if (line === '.') { messages.push(message.join('\r\n')); data = false; socket.write('250 queued locally\r\n'); }
          else message.push(line.replace(/^\.\./, '.'));
        } else if (/^(EHLO|HELO) /.test(line)) socket.write('250 local-fixture\r\n');
        else if (/^RCPT TO:/.test(line)) { recipients.push(line); socket.write('250 OK\r\n'); }
        else if (line === 'DATA') { data = true; message = []; socket.write('354 end with dot\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const originalConnect = net.Socket.prototype.connect;
  // Fail closed if the provider ignores the test SMTP target or attempts an external connection.
  net.Socket.prototype.connect = function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    assert.equal(options.host, '127.0.0.1'); assert.equal(options.port, port);
    return originalConnect.apply(this, args);
  };
  try {
    const mailer = provider.init({ devHost: '127.0.0.1', devPort: port, silent: true }, {
      defaultFrom: 'sender@example.invalid', defaultReplyTo: 'reply@example.invalid',
    });
    await mailer.send({ to: 'to@example.invalid', cc: 'cc@example.invalid', bcc: 'bcc@example.invalid',
      subject: 'Local compatibility fixture', text: 'Local text body', html: '<p>Local HTML body</p>',
      attachments: [{ filename: 'fixture.txt', content: Buffer.from('fixture attachment') }],
    });
    assert.equal(messages.length, 1);
    for (const address of ['to', 'cc', 'bcc']) assert(recipients.some(x => x.includes(address + '@example.invalid')));
    assert.match(messages[0], /From: sender@example\.invalid/);
    assert.match(messages[0], /Reply-To: reply@example\.invalid/);
    assert.match(messages[0], /Subject: Local compatibility fixture/);
    assert.doesNotMatch(messages[0], /^Bcc:/m);
    assert.match(messages[0], /Local text body/);
    assert.match(messages[0], /filename=fixture\.txt|filename="fixture\.txt"/);
    assert.match(messages[0], new RegExp(Buffer.from('fixture attachment').toString('base64')));
  } finally {
    net.Socket.prototype.connect = originalConnect;
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

test('updated mail composer keeps file and URL attachments disabled', async () => {
  const nodemailer = providerRequire('nodemailer');
  const mailer = nodemailer.createTransport({ streamTransport: true, buffer: true });
  for (const attachment of [{ path: __filename }, { href: 'https://example.invalid/never-fetch' }]) {
    await assert.rejects(mailer.sendMail({ from: 'sender@example.invalid', to: 'to@example.invalid',
      subject: 'fixture', text: 'fixture', disableFileAccess: true, disableUrlAccess: true,
      attachments: [attachment],
    }), /access rejected/i);
  }
});

test('mail parser does not merge comment-separated domains into a recipient', () => {
  const parse = providerRequire('nodemailer/lib/addressparser');
  const addresses = parse('"user"@example.invalid(comment)other.invalid');
  assert(addresses.length > 0);
  for (const item of addresses) assert(!/\s/.test(item.address), 'Malformed multi-domain address');
});

test('Strapi login redirects stay within the admin origin', async () => {
  const admin = path.dirname(require.resolve('@strapi/admin/package.json'));
  const { getRedirectTo } = await import(pathToFileURL(path.join(admin, 'dist/admin/admin/src/pages/Auth/utils.mjs')));
  for (const target of ['//example.invalid', '/\\example.invalid', 'https://example.invalid', 'javascript:alert(1)']) {
    assert.equal(getRedirectTo('?redirectTo=' + encodeURIComponent(target)), '/');
  }
  assert.equal(getRedirectTo('?redirectTo=' + encodeURIComponent('/content-manager?value=a%26b')), '/content-manager?value=a%26b');
});

test('Strapi JSONL transfer parser preserves own proto keys like native JSON.parse', async () => {
  const Parser = transferRequire('stream-json/jsonl/Parser');
  const source = '{"__proto__":{"fixture":true},"nested":{"__proto__":null},"name":"test"}\n';
  const parser = new Parser(); Readable.from([source.slice(0, 19), source.slice(19)]).pipe(parser);
  const values = []; for await (const item of parser) values.push(item.value);
  assert.equal(values.length, 1);
  assert.deepEqual(values[0], JSON.parse(source));
  assert.equal(Object.getPrototypeOf(values[0]), Object.prototype);
  assert.equal(Object.getPrototypeOf(values[0].nested), Object.prototype);
  assert.equal(values[0].fixture, undefined);
});

test('patched Markdown parser preserves normal content and rejects javascript links', () => {
  const MarkdownIt = editorRequire('markdown-it');
  const render = new MarkdownIt().render('## Заголовок\n\n**Описание**\n\n[Каталог](/catalog)\n\n[bad](javascript:alert(1))');
  assert.match(render, /<h2>Заголовок<\/h2>/); assert.match(render, /<strong>Описание<\/strong>/);
  assert.match(render, /href="\/catalog"/); assert.doesNotMatch(render, /href="javascript:/);
});
