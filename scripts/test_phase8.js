require('dotenv').config();
const http = require('http');

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;

// Simple helper to make HTTP requests
function req(method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
      },
    };
    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }

    const request = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: json });
        } catch (err) {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    request.on('error', reject);

    if (body) {
      request.write(JSON.stringify(body));
    }
    request.end();
  });
}

function pass(name, detail = '') {
  console.log(`✅ [PASS] ${name} ${detail ? `- ${detail}` : ''}`);
}

function fail(name, detail = '') {
  console.error(`❌ [FAIL] ${name} ${detail ? `- ${detail}` : ''}`);
  process.exitCode = 1;
}

function check(name, ok, detail = '') {
  if (ok) pass(name, detail);
  else fail(name, detail);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function runTests() {
  let adminToken = '';
  let refreshToken = '';
  const adminCreds = { email: `admin_${Date.now()}@test.com`, password: 'Password1', username: `admin_${Date.now()}`, role: 'admin' };

  try {
    section('Phase 8 - Production Scaling & Reliability Tests');

    // 1. Test JWT Refresh Tokens
    const regRes = await req('POST', '/api/auth/register', { body: adminCreds });
    check('Admin registration (Phase 8 format)', regRes.status === 201);
    
    if (regRes.status === 201) {
      adminToken = regRes.data.data.token;
      refreshToken = regRes.data.data.refreshToken;
      check('Registration returns refreshToken', !!refreshToken);
    }

    // 2. Test Refresh Endpoint
    if (refreshToken) {
      const refreshRes = await req('POST', '/api/auth/refresh', { body: { refreshToken } });
      check('Token Refresh', refreshRes.status === 200);
      if (refreshRes.status === 200) {
        adminToken = refreshRes.data.data.token;
        refreshToken = refreshRes.data.data.refreshToken;
        check('Refresh returns new tokens', !!adminToken && !!refreshToken);
      }
    }

    // 3. Test Health/Metrics Endpoint
    const healthRes = await req('GET', '/health');
    check('/health endpoint', healthRes.status === 200);

    const metricsRes = await req('GET', '/metrics');
    check('/metrics endpoint (Prometheus)', metricsRes.status === 200 && typeof metricsRes.data === 'string' && metricsRes.data.includes('process_cpu_seconds_total'));

    // Note: To test Redis and BullMQ locally, we assume they are running.
    // If Redis is not running, creating a wheel or starting a game will crash if we're not careful.
    // So we end the integration tests here, focusing on the API contracts added in Phase 8.

  } catch (err) {
    fail('Unhandled exception during tests', err.message);
  } finally {
    section('Cleanup');
    console.log('Test run finished.');
    if (process.exitCode !== 1) {
      console.log('All tests passed.');
      process.exit(0);
    } else {
      console.log('Some tests failed.');
      process.exit(1);
    }
  }
}

runTests();
