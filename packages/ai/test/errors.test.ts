import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testConnection } from '../src/connection.ts';
import { errorReport, httpError, rememberRequest } from '../src/core/errors.ts';
import { endpoint, fakeTransport, json } from './helpers.ts';

const service = 'aiplatform.googleapis.com';
const blockedMessage = `Requests to this API ${service} method google.cloud.aiplatform.v1.PredictionService.GenerateContent are blocked.`;
const googleError = (reason: string, message = blockedMessage, api = service) => ({
  error: {
    code: 403,
    message,
    status: 'PERMISSION_DENIED',
    details: [{
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason,
      domain: 'googleapis.com',
      metadata: { service: api, consumer: 'projects/123' },
    }],
  },
});

test('Google API restrictions explain the exact service and keep full, redacted diagnostics', () => {
  const body = JSON.stringify(googleError('API_KEY_SERVICE_BLOCKED'));
  const response = new Response(body, { status: 403 });
  rememberRequest(response, 'POST', `https://${service}/v1/publishers/google/models/gemini-3.7-flash:generateContent?key=test-secret`);
  const error = httpError('Vertex Agent', 403, body, response);
  assert.match(error.message, /Key 的 API 限制未允许 Vertex Agent/);
  assert.match(error.message, /确认允许 aiplatform\.googleapis\.com/);
  assert.doesNotMatch(error.message, /地区限制|被风控/);
  assert.equal(error.status, 403);
  assert.equal(error.retryable, false);
  assert.equal(error.detail, body);
  const report = errorReport(error);
  assert.match(report, /API_KEY_SERVICE_BLOCKED/);
  assert.match(report, /key=\*\*\*/);
  assert.doesNotMatch(report, /test-secret/);
});

test('a relay retaining only the Google blocked-method message still gives the correct hint', () => {
  const error = httpError('Vertex Agent', 403, JSON.stringify({ error: { message: blockedMessage } }));
  assert.match(error.message, /Key 的 API 限制/);
  assert.match(error.message, /切换模型不会解除此限制/);
});

test('website restrictions, disabled services, and AI Studio restrictions have distinct advice', () => {
  const website = httpError('Vertex Agent', 403, JSON.stringify(googleError('API_KEY_HTTP_REFERRER_BLOCKED', 'Requests from referer are blocked.')));
  assert.match(website.message, /网站来源限制/);
  assert.doesNotMatch(website.message, /API 限制未允许/);
  const disabled = httpError('Vertex Agent', 403, JSON.stringify(googleError('SERVICE_DISABLED', 'API has not been used or is disabled.')));
  assert.match(disabled.message, /所属项目未启用 Vertex Agent/);
  const studio = httpError('Gemini', 403, JSON.stringify(googleError('API_KEY_SERVICE_BLOCKED', 'Blocked.', 'generativelanguage.googleapis.com')));
  assert.match(studio.message, /未允许 Gemini \(AI Studio\)/);
  assert.match(studio.message, /确认允许 generativelanguage\.googleapis\.com/);
});

test('unrelated or malformed errors retain normal HTTP diagnostics', () => {
  for (const body of ['Forbidden', '{broken', JSON.stringify({ error: { message: 'Denied', details: [null, {}] } }), JSON.stringify(googleError('IAM_PERMISSION_DENIED', 'Permission denied'))]) {
    const error = httpError('Other API', 403, body);
    assert.match(error.message, /没有权限/);
    assert.doesNotMatch(error.message, /Key 的 API 限制/);
    assert.equal(error.detail, body);
  }
});

test('Vertex connection test reports a blocked key as failed without retrying or claiming success', async () => {
  const transport = fakeTransport(() => json(googleError('API_KEY_SERVICE_BLOCKED'), 403));
  const result = await testConnection(endpoint('vertex', transport, {
    baseUrl: `https://${service}/v1/publishers/google`, model: 'gemini-3.7-flash', key: 'test-secret',
  }), 'chat');
  assert.equal(result.ok, false);
  assert.match(result.message, /Key 的 API 限制未允许 Vertex Agent/);
  assert.match(result.detail!, /API_KEY_SERVICE_BLOCKED/);
  assert.doesNotMatch(result.detail!, /test-secret/);
  assert.equal(transport.calls.length, 1);
});
