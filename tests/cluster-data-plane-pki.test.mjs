import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, open, writeFile, rm, chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {createHash, randomUUID, X509Certificate} from 'node:crypto';
import {once} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {DockerSessionProvider} from '../service/docker-session-provider.mjs';
import {DockerMetadataClient} from '../service/docker-metadata-client.mjs';
import {DockerEffectClient} from '../service/docker-effect-session.mjs';
import {DockerAttachClient} from '../service/docker-attach-client.mjs';
import {RuntimeWitnessStore} from '../service/runtime-witness-store.mjs';
import {RuntimeRetirementStore} from '../service/runtime-retirement-store.mjs';
import {RuntimeDeploymentBindingStore} from '../service/runtime-deployment-binding.mjs';
import {SqliteSessionStore} from '../service/session-store.mjs';
import {deriveNativeTransportKey} from '../service/native-transport-key.mjs';
import {ClusterRpcClient} from '../service/cluster-rpc.mjs';
import {
  assembleClusterDockerWorker,
  assembleClusterGateway,
  loadPrivateTlsMaterial,
  verifyClusterDeploymentEnvironment,
  verifyTlsIdentityMaterial
} from '../service/cluster-ops.mjs';
import {createApiKeyAuthenticator} from '../service/session-http.mjs';
import {fixture as sourceFixture, renderer, KEY, OTHER} from './fixtures/viewer-access-harness.mjs';
import {snapshot} from './live-helpers.mjs';
import {agentHttpClient, agentPaths} from './fixtures/agent-http-client.mjs';
import {createClusterTestPki, readClusterTestTls} from './fixtures/cluster-test-pki.mjs';
import {witness} from './fixtures/runtime-witness-records.mjs';

const sha = x => createHash('sha256').update(x).digest('hex');
const VERSION = 'native-abi-structural-fixture-v1';
const SCOPES = [
  'sessions:create',
  'sessions:read',
  'sessions:release',
  'viewers:read',
  'viewers:control',
  'agents:read',
  'agents:write',
  'agents:end',
  'agents:observe'
];

async function until(callback, timeoutMs = 6000) {
  const end = performance.now() + timeoutMs;
  for (;;) {
    const value = await callback();
    if (value) return value;
    assert.ok(performance.now() < end, 'Cluster data-plane observation deadline');
    await delay(10);
  }
}

function issueExtraClusterIdentity(directory, name, {client = true, serial = 99} = {}) {
  const run = args =>
    execFileSync('/usr/bin/openssl', args, {
      cwd: directory,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 10000
    });
  writeFileSync(
    join(directory, `${name}.ext`),
    `[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${
      client ? 'clientAuth' : 'serverAuth'
    }\nsubjectAltName=DNS:${name}.test\n`
  );
  run(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${name}.key`]);
  chmodSync(join(directory, `${name}.key`), 0o600);
  run(['req', '-new', '-sha256', '-key', `${name}.key`, '-subj', `/CN=${name}.test`, '-out', `${name}.csr`]);
  run([
    'x509',
    '-req',
    '-sha256',
    '-in',
    `${name}.csr`,
    '-CA',
    'ca.crt',
    '-CAkey',
    'ca.key',
    '-set_serial',
    String(serial),
    '-days',
    '1',
    '-out',
    `${name}.crt`,
    '-extfile',
    `${name}.ext`,
    '-extensions',
    'leaf'
  ]);
  chmodSync(join(directory, `${name}.crt`), 0o600);
  return createHash('sha256')
    .update(new X509Certificate(readFileSync(join(directory, `${name}.crt`))).raw)
    .digest('hex');
}

async function createDockerNodeEnv(t, {baseDir, nodeId, index, pki, pins, leaseMs = 1500} = {}) {
  const nodeDir = join(baseDir, nodeId);
  await mkdir(nodeDir, {recursive: true, mode: 0o700});
  const source = await sourceFixture(t, {ttlSeconds: 120});
  source.source.latest = snapshot({translation: index});
  source.source.viewport = source.source.latest.viewport;

  const docs = new Map();
  const proxies = new Map();
  const starts = [];
  const agentCalls = [];
  const observations = [];
  const streamTranslations = [];
  const hooks = {};
  const networkId = (index + 1).toString(16).repeat(64).slice(0, 64);
  const endpointId = (index + 2).toString(16).repeat(64).slice(0, 64);
  const sandboxId = (index + 3).toString(16).repeat(64).slice(0, 64);
  const bridgeIp = '198.19.192.' + (index * 10 + 5);
  let nextCid = 1;

  function document(plan, cid) {
    const c = structuredClone(plan.create);
    return {
      Id: cid,
      Name: '/' + plan.containerName,
      Image: plan.imageId,
      Config: c,
      HostConfig: c.HostConfig,
      Mounts: c.HostConfig.Mounts.map(m => ({
        Type: 'bind',
        Source: m.Source,
        Destination: m.Target,
        RW: false,
        Propagation: 'rprivate'
      })),
      State: {
        Status: 'running',
        Running: true,
        Pid: 100 + index,
        StartedAt: '2026-10-18T00:00:00.123456789Z',
        Paused: false,
        Restarting: false,
        Dead: false,
        OOMKilled: false
      },
      NetworkSettings: {
        Ports: {},
        SandboxID: sandboxId,
        Networks: {
          bridge: {
            NetworkID: networkId,
            EndpointID: endpointId,
            IPAddress: bridgeIp,
            IPPrefixLen: 23,
            Gateway: '198.19.192.1'
          }
        }
      }
    };
  }

  class Metadata extends DockerMetadataClient {
    async inspectImage() {
      return {daemon: {id: 'daemon-' + nodeId}, document: {Config: {Env: ['PATH=/usr/local/bin']}}};
    }
    async listRuntimeCandidates() {
      return {daemon: {id: 'daemon-' + nodeId}, containerIds: [...docs.keys()]};
    }
    async inspectContainer(selector) {
      await hooks.container?.({selector});
      const doc = docs.get(selector) ?? [...docs.values()].find(x => x.Name === '/' + selector);
      return doc
        ? {found: true, daemon: {id: 'daemon-' + nodeId}, document: structuredClone(doc)}
        : {found: false, daemon: {id: 'daemon-' + nodeId}, selector};
    }
    async inspectNetwork() {
      await hooks.network?.();
      return {
        found: true,
        daemon: {id: 'daemon-' + nodeId},
        document: {
          Id: networkId,
          Name: 'bridge',
          Driver: 'bridge',
          Scope: 'local',
          IPAM: {Config: [{Subnet: '198.19.192.0/23', Gateway: '198.19.192.1'}]},
          Containers: Object.fromEntries(
            [...docs].map(([cid, doc]) => [
              cid,
              {
                Name: doc.Name.slice(1),
                EndpointID: endpointId,
                IPv4Address: doc.NetworkSettings.Networks.bridge.IPAddress + '/23'
              }
            ])
          )
        }
      };
    }
  }

  class Effects extends DockerEffectClient {
    async open({kind, plan, containerId}) {
      const before = docs.get(containerId);
      return {
        inspect: () => ({
          inspection: before
            ? {found: true, daemon: {id: 'daemon-' + nodeId}, document: structuredClone(before)}
            : null,
          absent: !before
        }),
        perform: async authorize => {
          const receipt = authorize();
          if (kind === 'create') {
            await hooks.createEffect?.({plan});
            const cid = (index * 1000 + nextCid++).toString(16).padStart(64, '0');
            docs.set(cid, document(plan, cid));
            return {containerId: cid};
          }
          if (kind === 'start') {
            await hooks.startEffect?.({plan, containerId});
            return {};
          }
          await hooks.removeEffect?.({plan, containerId});
          docs.delete(containerId);
          return {
            kind: 'remove',
            containerId,
            daemonId: 'daemon-' + nodeId,
            connectionId: randomUUID(),
            httpStatus: before ? 204 : 404,
            authorizationRevision: receipt.revision,
            effectAttempted: !!before,
            alreadyAbsent: !before
          };
        },
        close: async () => ({status: 'closed'})
      };
    }
  }

  class Attach extends DockerAttachClient {
    open({plan, containerId}) {
      const output = new PassThrough();
      const done = (() => {
        let resolve;
        const promise = new Promise(r => (resolve = r));
        return {promise, resolve};
      })();
      let ended = false;
      let bytes = '';
      let activeContext = null;
      const send = v =>
        output.write(JSON.stringify({protocol: 'session-worker-v1', sessionId: plan.sessionId, ...v}) + '\n');
      const finish = () => {
        if (ended) return;
        ended = true;
        output.end();
        done.resolve({code: 0, signal: null});
      };
      const input = new Writable({
        write(chunk, _encoding, callback) {
          try {
            bytes += chunk;
            for (let n; (n = bytes.indexOf('\n')) >= 0; ) {
              const msg = JSON.parse(bytes.slice(0, n));
              bytes = bytes.slice(n + 1);
              if (msg.type === 'Start') {
                const derivedKey = deriveNativeTransportKey({
                  ownerKey: msg.ownerKey,
                  sessionId: plan.sessionId,
                  tenantId: plan.tenantId,
                  region: plan.region
                });
                starts.push({sessionId: plan.sessionId, ownerKey: msg.ownerKey, expectedKey: derivedKey});
                void Promise.resolve()
                  .then(() => hooks.startChannel?.({sessionId: plan.sessionId}))
                  .then(() => {
                    if (!ended)
                      send({
                        type: 'Ready',
                        version: VERSION,
                        capabilities: ['agent-rpc-v1', 'agent-observe-v1']
                      });
                  });
              }
              if (msg.type === 'AgentCall') {
                const req = msg.request;
                void Promise.resolve()
                  .then(async () => {
                    if (req.op === 'begin') {
                      activeContext = {
                        binding: {
                          tenantId: plan.tenantId,
                          sessionId: plan.sessionId,
                          targetId: 'target_' + randomUUID(),
                          runId: 'run_' + randomUUID()
                        },
                        fence: {
                          controlSessionId: randomUUID(),
                          controlVersion: 0,
                          pageEpoch: 1,
                          viewportVersion: 1
                        }
                      };
                      return {ok: true, result: activeContext};
                    }
                    if (req.op === 'context') return {ok: true, result: activeContext};
                    if (req.op === 'observation-context') {
                      return {
                        ok: true,
                        result: {
                          binding: activeContext.binding,
                          document: {
                            controlSessionId: activeContext.fence.controlSessionId,
                            pageEpoch: activeContext.fence.pageEpoch,
                            viewportVersion: activeContext.fence.viewportVersion
                          }
                        }
                      };
                    }
                    if (req.op === 'observe') {
                      observations.push({sessionId: plan.sessionId, query: req.query});
                      return {
                        ok: true,
                        result: {
                          stage: 'observed',
                          binding: activeContext.binding,
                          document: req.context.document,
                          observationId: 'obs_' + randomUUID(),
                          revision: observations.length,
                          observedAt: new Date().toISOString(),
                          version: VERSION,
                          scope: 'main-document-light-dom',
                          query: req.query,
                          limits: req.limits ?? {maxNodes: 8, maxChars: 1024, maxVisited: 128},
                          url: 'https://board.internal/canvas',
                          title: 'Remote Paint Canvas',
                          nodes: [
                            {
                              elementId: 'elh_' + randomUUID(),
                              tag: 'button',
                              id: 'draw-action',
                              role: 'button',
                              name: 'Draw',
                              text: 'Draw',
                              value: null,
                              redacted: false
                            }
                          ],
                          visited: 1,
                          truncated: false
                        }
                      };
                    }
                    if (req.op === 'end') {
                      const binding = activeContext.binding;
                      activeContext = null;
                      return {ok: true, result: {stage: 'run-closed', binding}};
                    }
                    agentCalls.push({sessionId: plan.sessionId, tool: req.tool, params: req.params});
                    if (hooks.agentPerform) await hooks.agentPerform({sessionId: plan.sessionId, req});
                    return {
                      ok: true,
                      result: {
                        stage: 'input-injected',
                        binding: activeContext.binding,
                        fence: req.context.fence,
                        inputs: 1
                      }
                    };
                  })
                  .then(
                    answer => {
                      if (!ended) send({type: 'AgentResult', requestId: msg.requestId, ...answer});
                    },
                    () => {
                      if (!ended)
                        send({
                          type: 'AgentResult',
                          requestId: msg.requestId,
                          ok: false,
                          error: {code: 'AGENT_INPUT_FAILED', outcome: 'unknown'}
                        });
                    }
                  );
              }
              if (msg.type === 'Close') {
                send({type: 'Closed', reason: 'released', code: null});
                finish();
              }
            }
            callback();
          } catch (error) {
            callback(error);
          }
        }
      });
      const proxy = {
        input,
        output,
        clientDone: done.promise,
        attached: Promise.resolve({containerId}),
        status: () => ({pid: null, transportExited: ended}),
        stop: async () => {
          finish();
          return {status: 'closed'};
        },
        lose: () => {
          output.emit('end');
          finish();
        }
      };
      proxies.set(plan.sessionId, proxy);
      queueMicrotask(() => send({type: 'WorkerHello', runtimeWitness: witness()}));
      return proxy;
    }
  }

  const projectPath = join(nodeDir, 'project');
  const browserPath = join(nodeDir, 'browser');
  await mkdir(projectPath);
  await mkdir(browserPath);
  const files = {};
  const required = [
    'service/native-session-worker.mjs',
    'service/session-worker.mjs',
    'service/native-transport-key.mjs',
    'service/native-session-resource.mjs',
    'service/linux-runtime-witness.mjs',
    'live.mjs',
    'live/transport.mjs',
    'native/bin/aarch64-unknown-linux-gnu/remote-paint-broker'
  ];
  for (const n of required) {
    const p = join(projectPath, n);
    const b = Buffer.from('Explicit structural source placeholder; never executed\n');
    await mkdir(dirname(p), {recursive: true});
    await writeFile(p, b);
    files[n] = sha(b);
  }
  await writeFile(join(browserPath, 'headless_shell'), 'Explicit structural browser placeholder; never executed\n');
  const projectManifest = join(nodeDir, 'project-manifest.json');
  const browserManifest = join(nodeDir, 'browser-manifest.json');
  const pb = JSON.stringify({schema: 'runtime-source-files-v1', files});
  const bb = JSON.stringify({
    schema: 'runtime-source-files-v1',
    files: {headless_shell: sha('Explicit structural browser placeholder; never executed\n')}
  });
  await writeFile(projectManifest, pb);
  await writeFile(browserManifest, bb);
  const configuration = {
    region: 'test',
    deploymentId: 'deploy-' + nodeId,
    daemonId: 'daemon-' + nodeId,
    imageId: 'sha256:' + 'b'.repeat(64),
    projectPath,
    browserPath,
    projectManifestSha256: sha(pb),
    browserManifestSha256: sha(bb),
    imageEnvironment: ['PATH=/usr/local/bin']
  };
  const statePath = join(nodeDir, 'state.sqlite');
  const bindingDir = join(nodeDir, 'binding');
  const witnessDir = join(nodeDir, 'witness');
  const retirementDir = join(nodeDir, 'retirement');

  let booted = null;
  async function boot(incarnation = 'boot-' + nodeId + '-1') {
    const store = new SqliteSessionStore({path: statePath});
    const metadata = new Metadata({socketPath: join(nodeDir, 'unused.sock'), daemonId: 'daemon-' + nodeId});
    const effects = new Effects({socketPath: join(nodeDir, 'unused.sock'), daemonId: 'daemon-' + nodeId});
    const attach = new Attach({
      socketPath: join(nodeDir, 'unused.sock'),
      daemonId: 'daemon-' + nodeId,
      maxConcurrent: 4
    });
    const witnessStore = new RuntimeWitnessStore({directory: witnessDir});
    const retirementStore = new RuntimeRetirementStore({directory: retirementDir, witnessStore});
    if (!booted) {
      await RuntimeDeploymentBindingStore.bootstrap({directory: bindingDir, store, metadata, configuration});
    }
    const provider = new DockerSessionProvider({
      store,
      deploymentBinding: new RuntimeDeploymentBindingStore({directory: bindingDir}),
      configuration,
      metadata,
      effects,
      attach,
      witnessStore,
      retirementStore,
      projectManifest,
      browserManifest,
      maxSessions: 4
    });
    await provider.initialize();
    const assembled = assembleClusterDockerWorker({
      provider,
      store,
      nodeId,
      incarnation,
      region: 'test',
      version: VERSION,
      leaseMs,
      maxSessions: 16,
      tls: readClusterTestTls(pki, nodeId),
      clientSha256: [pins.controller],
      // On the Worker host itself, translate the Worker-local Docker container bridge IP
      // (http://198.19.192.x:4176) to the local fixture stream transport when bridging
      // an incoming mTLS GET /v1/cluster/stream tunnel from the Gateway.
      resolveStreamTarget: async (target, request) => {
        assert.equal(target.streamOrigin, 'http://' + bridgeIp + ':4176');
        streamTranslations.push({sessionId: request.sessionId, streamOrigin: target.streamOrigin});
        return Object.freeze({
          ...target,
          origin: source.transport.origin,
          streamOrigin: source.transport.streamOrigin,
          key: source.transport.key
        });
      }
    });
    await assembled.initialize();
    assembled.server.listen(0, '127.0.0.1');
    await once(assembled.server, 'listening');
    const endpoint = 'https://127.0.0.1:' + assembled.server.address().port;
    booted = {
      store,
      metadata,
      effects,
      attach,
      witnessStore,
      retirementStore,
      provider,
      assembled,
      endpoint,
      incarnation,
      async stop() {
        const closed = await assembled.close();
        await attach.close();
        await effects.close();
        await metadata.close();
        try {
          store.close();
        } catch {}
        return closed;
      }
    };
    return booted;
  }

  await boot('boot-' + nodeId + '-1');
  return {
    nodeId,
    bridgeIp,
    source,
    docs,
    proxies,
    starts,
    agentCalls,
    observations,
    streamTranslations,
    hooks,
    statePath,
    retirementDir,
    get current() {
      return booted;
    },
    boot,
    spec() {
      return {
        nodeId,
        incarnation: booted.incarnation,
        endpoint: booted.endpoint,
        serverName: nodeId + '.test',
        serverSha256: pins[nodeId],
        capacity: 2,
        validateSource: (target, request) =>
          target.tenantId === request.tenantId &&
          target.sessionId === request.sessionId &&
          target.version === VERSION &&
          target.origin === 'http://127.0.0.1:4175' &&
          target.streamOrigin === 'http://' + bridgeIp + ':4176' &&
          /^[a-f0-9]{64}$/.test(target.key)
      };
    }
  };
}

test('loadPrivateTlsMaterial and verifyTlsIdentityMaterial enforce 0700/0600 permissions, CA chain, key pair match, SAN hostname and expiry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cluster-pki-verify-'));
  t.after(async () => rm(directory, {recursive: true, force: true}));
  const pki = join(directory, 'pki');
  const pins = createClusterTestPki(pki);
  await chmod(join(pki, 'controller.crt'), 0o600);
  await chmod(join(pki, 'worker-a.crt'), 0o600);
  await chmod(join(pki, 'ca.crt'), 0o600);

  const controllerLoaded = loadPrivateTlsMaterial({
    directory: pki,
    keyFile: 'controller.key',
    certFile: 'controller.crt',
    caFile: 'ca.crt',
    expectedServerName: 'controller.test'
  });
  assert.equal(controllerLoaded.sha256, pins.controller);

  const workerLoaded = loadPrivateTlsMaterial({
    directory: pki,
    keyFile: 'worker-a.key',
    certFile: 'worker-a.crt',
    caFile: 'ca.crt',
    expectedServerName: 'worker-a.test'
  });
  assert.equal(workerLoaded.sha256, pins['worker-a']);

  // Expired or not-yet-valid identity window is rejected with CLUSTER_TLS_EXPIRED.
  assert.throws(
    () =>
      verifyTlsIdentityMaterial(workerLoaded.tls, {
        now: () => Date.now() + 30 * 86_400_000,
        expectedServerName: 'worker-a.test'
      }),
    err => err?.code === 'CLUSTER_TLS_EXPIRED'
  );

  // SAN hostname mismatch is rejected with CLUSTER_TLS_HOSTNAME.
  assert.throws(
    () =>
      verifyTlsIdentityMaterial(workerLoaded.tls, {
        expectedServerName: 'wrong-host.test'
      }),
    err => err?.code === 'CLUSTER_TLS_HOSTNAME'
  );

  // Mismatched private key and certificate is rejected with CLUSTER_TLS_KEY_MISMATCH.
  assert.throws(
    () =>
      verifyTlsIdentityMaterial({
        key: controllerLoaded.tls.key,
        cert: workerLoaded.tls.cert,
        ca: workerLoaded.tls.ca
      }),
    err => err?.code === 'CLUSTER_TLS_KEY_MISMATCH'
  );

  // World-readable private key file is rejected with CLUSTER_ARCHIVE_FILE.
  const badDir = join(directory, 'bad-pki');
  await mkdir(badDir, {mode: 0o700});
  await writeFile(join(badDir, 'key.pem'), controllerLoaded.tls.key, {mode: 0o644});
  await chmod(join(badDir, 'key.pem'), 0o644);
  await writeFile(join(badDir, 'cert.pem'), controllerLoaded.tls.cert, {mode: 0o600});
  await writeFile(join(badDir, 'ca.pem'), controllerLoaded.tls.ca, {mode: 0o600});
  assert.throws(
    () => loadPrivateTlsMaterial({directory: badDir}),
    err => err?.code === 'CLUSTER_ARCHIVE_FILE'
  );
});

test('verifyClusterDeploymentEnvironment produces deterministic preflight audit receipts and rejects role conflicts or raw CDP ports', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cluster-preflight-'));
  t.after(async () => rm(directory, {recursive: true, force: true}));
  const pki = join(directory, 'pki');
  const archiveDir = join(directory, 'archive');
  await mkdir(archiveDir, {mode: 0o700});
  const pins = createClusterTestPki(pki);
  const placementPath = join(directory, 'placement.sqlite');
  const registryPath = join(directory, 'registry.sqlite');
  const fd = await open(placementPath, 'wx', 0o600);
  await fd.close();

  const controllerTls = readClusterTestTls(pki, 'controller');
  const validateSource = () => true;
  const receipt = verifyClusterDeploymentEnvironment({
    placementPath,
    registryPath,
    archiveDir,
    region: 'test',
    arch: 'arm64',
    version: VERSION,
    controllerTls,
    workers: [
      {
        nodeId: 'worker-a',
        incarnation: 'boot-worker-a-1',
        endpoint: 'https://127.0.0.1:19443',
        serverName: 'worker-a.test',
        serverSha256: pins['worker-a'],
        capacity: 2,
        validateSource
      },
      {
        nodeId: 'worker-b',
        incarnation: 'boot-worker-b-1',
        endpoint: 'https://127.0.0.1:19444',
        serverName: 'worker-b.test',
        serverSha256: pins['worker-b'],
        capacity: 2,
        validateSource
      }
    ]
  });
  assert.equal(receipt.controllerSha256, pins.controller);
  assert.equal(receipt.workers.length, 2);
  assert.equal(receipt.rawCdpExposed, false);
  assert.match(receipt.sha256, /^[0-9a-f]{64}$/);

  // Forbidden raw CDP / internal container ports (9222, 4175, 4176) on Worker RPC endpoints are rejected.
  for (const forbiddenPort of [9222, 4175, 4176]) {
    assert.throws(
      () =>
        verifyClusterDeploymentEnvironment({
          placementPath,
          archiveDir,
          region: 'test',
          arch: 'arm64',
          version: VERSION,
          controllerTls,
          workers: [
            {
              nodeId: 'worker-a',
              incarnation: 'boot-worker-a-1',
              endpoint: `https://127.0.0.1:${forbiddenPort}`,
              serverName: 'worker-a.test',
              serverSha256: pins['worker-a'],
              capacity: 2,
              validateSource
            }
          ]
        }),
      err => err?.code === 'CLUSTER_DEPLOYMENT_CDP_FORBIDDEN'
    );
  }

  // Controller certificate reused as Worker serverSha256 is rejected with CLUSTER_DEPLOYMENT_ROLE_CONFLICT.
  assert.throws(
    () =>
      verifyClusterDeploymentEnvironment({
        placementPath,
        archiveDir,
        region: 'test',
        arch: 'arm64',
        version: VERSION,
        controllerTls,
        workers: [
          {
            nodeId: 'worker-a',
            incarnation: 'boot-worker-a-1',
            endpoint: 'https://127.0.0.1:19443',
            serverName: 'worker-a.test',
            serverSha256: pins.controller,
            capacity: 2,
            validateSource
          }
        ]
      }),
    err => err?.code === 'CLUSTER_DEPLOYMENT_ROLE_CONFLICT'
  );
});

test('cross-machine mTLS private data-plane WebSocket tunnel bridges Viewer frames without Gateway direct access to container bridge IPs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cluster-dataplane-tunnel-'));
  const pki = join(directory, 'pki');
  const archiveDir = join(directory, 'archives');
  await mkdir(archiveDir, {mode: 0o700});
  const pins = createClusterTestPki(pki);

  const nodeA = await createDockerNodeEnv(t, {
    baseDir: directory,
    nodeId: 'worker-a',
    index: 0,
    pki,
    pins,
    leaseMs: 1500
  });
  const placementPath = join(directory, 'placement.sqlite');
  const registryPath = join(directory, 'registry.sqlite');
  const fd = await open(placementPath, 'wx', 0o600);
  await fd.close();

  // Notice: assembleClusterGateway is configured WITHOUT a custom resolveSource callback!
  // It uses the default provider.resolveSourceStream(req) which opens an mTLS WebSocket tunnel
  // (wss://127.0.0.1:<workerPort>/v1/cluster/stream) to the Worker instead of dialing 198.19.192.5:4176.
  const gateway = assembleClusterGateway({
    placementPath,
    registryPath,
    region: 'test',
    arch: 'arm64',
    version: VERSION,
    leaseMs: 1500,
    heartbeatMs: 180,
    globalQuota: 4,
    tenantQuota: 4,
    actionKey: 'c'.repeat(64),
    authenticate: createApiKeyAuthenticator([
      {apiKey: KEY, tenantId: 'a', scopes: SCOPES},
      {apiKey: OTHER, tenantId: 'b', scopes: SCOPES}
    ]),
    controllerTls: readClusterTestTls(pki, 'controller'),
    workers: [nodeA.spec()]
  });
  t.after(async () => {
    await gateway.shutdown().catch(() => {});
    await nodeA.current?.stop().catch(() => {});
    await rm(directory, {recursive: true, force: true});
  });

  await gateway.initialize();
  gateway.http.listen(0, '127.0.0.1');
  await once(gateway.http, 'listening');
  const base = 'http://127.0.0.1:' + gateway.http.address().port;
  const api = agentHttpClient(base, KEY);

  const created = await api('POST', '/v1/sessions', {
    data: {region: 'test', ttlSeconds: 60},
    idempotencyKey: 'mtls-tunnel-session'
  });
  assert.equal(created.status, 202);
  await until(() => gateway.registry.getOperation('a', created.body.data.operationId).status !== 'pending');
  const session = gateway.registry.requireReady('a', created.body.data.sessionId);

  // Verify resolveSourceStream returns the 7 validated fields plus a connectStream capability.
  const streamTarget = await gateway.provider.resolveSourceStream({
    tenantId: 'a',
    sessionId: session.sessionId,
    region: 'test',
    version: VERSION
  });
  assert.equal(streamTarget.streamOrigin, 'http://' + nodeA.bridgeIp + ':4176');
  assert.equal(typeof streamTarget.connectStream, 'function');

  // Public Viewer connects to Gateway /v1/viewer/... and receives Welcome + FrameCommit + binary tiles
  // bridged through the mTLS GET /v1/cluster/stream tunnel on worker-a.
  const audience = 'https://mtls-tunnel-viewer.example';
  const ticket = await api('POST', '/v1/sessions/' + session.sessionId + '/viewer-tickets', {
    data: {role: 'readonly', audience, ttlSeconds: 30}
  });
  assert.equal(ticket.status, 200);
  const ws = new WebSocket(base.replace('http:', 'ws:') + ticket.body.data.streamPath, {origin: audience});
  t.after(() => ws.terminate());
  const messages = [];
  let binaries = 0;
  ws.on('message', (bytes, binary) => {
    if (binary) binaries++;
    else {
      const m = JSON.parse(bytes.toString());
      messages.push(m);
      if (m.type === 'FrameCommit') {
        ws.send(JSON.stringify({type: 'FrameAck', frameId: m.frameId, pageEpoch: m.pageEpoch}));
      }
    }
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({type: 'Hello', protocol: 4, renderer}));
  await until(() => messages.some(m => m.type === 'FrameCommit'));
  assert.equal(messages.find(m => m.type === 'Welcome').viewerSessionId, session.sessionId);
  assert.ok(binaries > 0);
  assert.equal(nodeA.streamTranslations.length, 1);
  assert.equal(nodeA.streamTranslations[0].sessionId, session.sessionId);

  // Tampering with the derived Source key on mTLS /v1/cluster/stream is rejected before bridging.
  const routed = gateway.placement.route({
    tenantId: 'a',
    sessionId: session.sessionId,
    version: VERSION
  });
  const directClient = new ClusterRpcClient({
    endpoint: nodeA.current.endpoint,
    serverName: 'worker-a.test',
    serverSha256: pins['worker-a'],
    tls: readClusterTestTls(pki, 'controller')
  });
  t.after(() => directClient.close());
  await assert.rejects(
    () =>
      directClient.openStream({
        placement: {
          sessionId: routed.sessionId,
          tenantId: routed.tenantId,
          nodeId: routed.nodeId,
          generation: routed.generation,
          epoch: routed.epoch
        },
        request: {
          tenantId: 'a',
          sessionId: session.sessionId,
          region: 'test',
          version: VERSION
        },
        key: '0'.repeat(64)
      }),
    err => err?.code === 'CLUSTER_STREAM_UNAVAILABLE'
  );

  // Releasing the session closes the container and terminates the active mTLS data-plane stream.
  const closedStream = once(ws, 'close');
  const del = await api('DELETE', '/v1/sessions/' + session.sessionId);
  assert.equal(del.status, 202);
  await closedStream;
  await until(() => gateway.registry.getSession('a', session.sessionId).state === 'closed');
});

test('private Agent observation and action routing over mTLS RPC with strict rejection of raw CDP routes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cluster-cdp-isolation-'));
  const pki = join(directory, 'pki');
  const archiveDir = join(directory, 'archives');
  await mkdir(archiveDir, {mode: 0o700});
  const pins = createClusterTestPki(pki);

  const nodeA = await createDockerNodeEnv(t, {
    baseDir: directory,
    nodeId: 'worker-a',
    index: 0,
    pki,
    pins,
    leaseMs: 1500
  });
  const placementPath = join(directory, 'placement.sqlite');
  const registryPath = join(directory, 'registry.sqlite');
  const fd = await open(placementPath, 'wx', 0o600);
  await fd.close();

  const gateway = assembleClusterGateway({
    placementPath,
    registryPath,
    region: 'test',
    arch: 'arm64',
    version: VERSION,
    leaseMs: 1500,
    heartbeatMs: 180,
    globalQuota: 4,
    tenantQuota: 4,
    actionKey: 'c'.repeat(64),
    authenticate: createApiKeyAuthenticator([
      {apiKey: KEY, tenantId: 'a', scopes: SCOPES},
      {apiKey: OTHER, tenantId: 'b', scopes: SCOPES}
    ]),
    controllerTls: readClusterTestTls(pki, 'controller'),
    workers: [nodeA.spec()]
  });
  t.after(async () => {
    await gateway.shutdown().catch(() => {});
    await nodeA.current?.stop().catch(() => {});
    await rm(directory, {recursive: true, force: true});
  });

  await gateway.initialize();
  gateway.http.listen(0, '127.0.0.1');
  await once(gateway.http, 'listening');
  const base = 'http://127.0.0.1:' + gateway.http.address().port;
  const api = agentHttpClient(base, KEY);

  const created = await api('POST', '/v1/sessions', {
    data: {region: 'test', ttlSeconds: 60},
    idempotencyKey: 'cdp-isolation-session'
  });
  assert.equal(created.status, 202);
  await until(() => gateway.registry.getOperation('a', created.body.data.operationId).status !== 'pending');
  const session = gateway.registry.requireReady('a', created.body.data.sessionId);

  // Create an Agent run and execute managed DOM observation + input injection over mTLS RPC.
  const createdRun = await api('POST', agentPaths.create(session.sessionId), {
    data: {region: 'test', version: VERSION},
    idempotencyKey: 'cdp-agent-run'
  });
  assert.equal(createdRun.status, 202);
  const runId = createdRun.body.data.agentRunId;
  await until(async () => (await api('GET', agentPaths.run(runId))).body.data.state === 'active');

  const obsCtxRes = await api('GET', `/v1/agent-runs/${runId}/observation-context`);
  assert.equal(obsCtxRes.status, 200);
  const obsContext = obsCtxRes.body.data;

  const observed = await api('POST', `/v1/agent-runs/${runId}/observations`, {
    data: {
      context: obsContext,
      query: {kind: 'snapshot'}
    }
  });
  assert.equal(observed.status, 200);
  assert.equal(observed.body.data.stage, 'observed');
  assert.equal(observed.body.data.nodes[0].id, 'draw-action');
  assert.equal(nodeA.observations.length, 1);

  const execContext = (await api('GET', agentPaths.context(runId))).body.data;
  const action = await api('POST', agentPaths.invocations(runId), {
    data: {tool: 'insertText', params: {text: 'private-mtls-agent'}, context: execContext},
    idempotencyKey: 'cdp-agent-action'
  });
  assert.equal(action.status, 202);
  await until(
    async () => (await api('GET', agentPaths.invocation(action.body.data.invocationId))).body.data.state === 'injected'
  );
  assert.equal(nodeA.agentCalls.length, 1);

  await api('POST', agentPaths.end(runId));
  await until(async () => (await api('GET', agentPaths.run(runId))).body.data.state === 'closed');

  // Raw CDP discovery/debugging endpoints (/json, /json/version, /json/list, /devtools/browser/...)
  // must be rejected on the public Gateway (404) and raw CDP WebSocket upgrades rejected (403).
  for (const rawCdpPath of ['/json', '/json/version', '/json/list', '/devtools/browser/123']) {
    const res = await fetch(base + rawCdpPath, {
      headers: {authorization: 'Bearer ' + KEY}
    });
    assert.equal(res.status, 404);
  }

  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(base.replace('http:', 'ws:') + '/devtools/browser/123');
        ws.once('open', () => resolve(true));
        ws.once('unexpected-response', (_req, res) => {
          ws.terminate();
          reject(Object.assign(new Error(`status:${res.statusCode}`), {statusCode: res.statusCode}));
        });
        ws.once('error', reject);
      }),
    err => err?.statusCode === 403
  );
});

test('live mTLS certificate rotation and immediate revocation disconnect revoked controller streams and RPCs while rotated identity continues', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cluster-cert-rotation-'));
  const pki = join(directory, 'pki');
  const archiveDir = join(directory, 'archives');
  await mkdir(archiveDir, {mode: 0o700});
  const pins = createClusterTestPki(pki);
  pins['controller-v2'] = issueExtraClusterIdentity(pki, 'controller-v2', {client: true, serial: 42});

  const nodeA = await createDockerNodeEnv(t, {
    baseDir: directory,
    nodeId: 'worker-a',
    index: 0,
    pki,
    pins,
    leaseMs: 1500
  });
  const placementPath = join(directory, 'placement.sqlite');
  const registryPath = join(directory, 'registry.sqlite');
  const fd = await open(placementPath, 'wx', 0o600);
  await fd.close();

  const gateway = assembleClusterGateway({
    placementPath,
    registryPath,
    region: 'test',
    arch: 'arm64',
    version: VERSION,
    leaseMs: 1500,
    heartbeatMs: 180,
    globalQuota: 4,
    tenantQuota: 4,
    actionKey: 'c'.repeat(64),
    authenticate: createApiKeyAuthenticator([
      {apiKey: KEY, tenantId: 'a', scopes: SCOPES},
      {apiKey: OTHER, tenantId: 'b', scopes: SCOPES}
    ]),
    controllerTls: readClusterTestTls(pki, 'controller'),
    workers: [nodeA.spec()]
  });
  t.after(async () => {
    await gateway.shutdown().catch(() => {});
    await nodeA.current?.stop().catch(() => {});
    await rm(directory, {recursive: true, force: true});
  });

  await gateway.initialize();
  gateway.http.listen(0, '127.0.0.1');
  await once(gateway.http, 'listening');
  const base = 'http://127.0.0.1:' + gateway.http.address().port;
  const api = agentHttpClient(base, KEY);

  const created = await api('POST', '/v1/sessions', {
    data: {region: 'test', ttlSeconds: 60},
    idempotencyKey: 'cert-rot-session'
  });
  assert.equal(created.status, 202);
  await until(() => gateway.registry.getOperation('a', created.body.data.operationId).status !== 'pending');
  const session = gateway.registry.requireReady('a', created.body.data.sessionId);

  // Open an active mTLS stream using the v1 controller certificate.
  const routed = gateway.placement.route({
    tenantId: 'a',
    sessionId: session.sessionId,
    version: VERSION
  });
  const placement = {
    sessionId: routed.sessionId,
    tenantId: routed.tenantId,
    nodeId: routed.nodeId,
    generation: routed.generation,
    epoch: routed.epoch
  };
  const v1Client = new ClusterRpcClient({
    endpoint: nodeA.current.endpoint,
    serverName: 'worker-a.test',
    serverSha256: pins['worker-a'],
    tls: readClusterTestTls(pki, 'controller')
  });
  t.after(() => v1Client.close());
  const v1Stream = await v1Client.openStream({
    placement,
    request: {
      tenantId: 'a',
      sessionId: session.sessionId,
      region: 'test',
      version: VERSION
    },
    key: nodeA.starts[0].expectedKey
  });

  // Step 1: Dual-trust window on Worker (trust both controller v1 and controller-v2).
  const stage1 = nodeA.current.assembled.rotatePeers([pins.controller, pins['controller-v2']]);
  assert.equal(stage1.peers.length, 2);

  // Step 2: Rotate Gateway's outbound client identity to controller-v2.
  const rotated = await gateway.operations.rotateWorkerTls('worker-a', {
    tls: readClusterTestTls(pki, 'controller-v2')
  });
  assert.equal(rotated.available, true);

  // Step 3: Revoke v1 controller fingerprint on Worker (only controller-v2 remains allowed).
  const v1StreamClosed = once(v1Stream, 'close');
  const stage3 = nodeA.current.assembled.rotatePeers([pins['controller-v2']]);
  assert.equal(stage3.peers.length, 1);
  assert.ok(stage3.revokedSockets >= 1);

  // Active v1 stream is immediately terminated on revocation.
  await v1StreamClosed;

  // Revoked v1 client can no longer invoke RPCs or open streams.
  await assert.rejects(
    () =>
      v1Client.call('resolve', {
        placement,
        request: {
          tenantId: 'a',
          sessionId: session.sessionId,
          region: 'test',
          version: VERSION
        }
      }),
    err => err?.code === 'CLUSTER_RPC_UNAVAILABLE'
  );

  // Meanwhile, the Gateway (using controller-v2) continues heartbeating, resolving streams, and retiring sessions cleanly.
  const audience = 'https://rotated-viewer.example';
  const ticket = await api('POST', '/v1/sessions/' + session.sessionId + '/viewer-tickets', {
    data: {role: 'readonly', audience, ttlSeconds: 30}
  });
  assert.equal(ticket.status, 200);
  const ws = new WebSocket(base.replace('http:', 'ws:') + ticket.body.data.streamPath, {origin: audience});
  t.after(() => ws.terminate());
  const messages = [];
  ws.on('message', (bytes, binary) => {
    if (!binary) messages.push(JSON.parse(bytes.toString()));
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({type: 'Hello', protocol: 4, renderer}));
  await until(() => messages.some(m => m.type === 'Welcome'));
  ws.terminate();

  const del = await api('DELETE', '/v1/sessions/' + session.sessionId);
  assert.equal(del.status, 202);
  await until(() => gateway.registry.getSession('a', session.sessionId).state === 'closed');
});
