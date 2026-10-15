import test from 'node:test';
import assert from 'node:assert/strict';
import {startDynamicFixture} from './dynamic-fixture.mjs';

test('dynamic source images really require the browser HttpOnly session cookie',async()=>{
  const fixture=await startDynamicFixture();
  try {
    assert.equal((await fetch(new URL('/private.png',fixture.url))).status,403);
    const page=await fetch(fixture.url);
    const cookie=page.headers.get('set-cookie');
    assert.match(cookie,/HttpOnly/);
    assert.equal((await fetch(new URL('/private.png',fixture.url),{headers:{Cookie:cookie.split(';')[0]}})).status,200);
    assert.equal(fixture.stats.rejectedImageRequests,1);
    assert.equal(fixture.stats.authorizedImageRequests,1);
  }finally{await fixture.close();}
});
