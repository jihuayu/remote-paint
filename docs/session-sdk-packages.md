# Session SDK 本地包验收（开发中）

客户端源码可打包为两个独立开发产物：Node ESM `@remote-paint/session-client@0.0.0-dev.0` 与 Python `remote-paint-session==0.0.0.dev0`。不包含服务端、Native、Chromium、Viewer、数据库或测试凭据，尚未公开发布。Node 包保持 `private:true`，Python 包为开发版本；当前不能用这些本地包替代 K1/K3/K8/K9 的完整产品验收。

## 构建

从项目目录构建到单独的临时目录。Node 仅需 npm；Python 的固定构建后端为 setuptools 80.9.0。构建器可使用 build 1.3.0，独立输出目录由调用方创建。不要将开发源码目录当作已安装的包。

```sh
npm pack ./sdk --ignore-scripts --pack-destination /absolute/work/sdk-packages
python -m build --wheel --outdir /absolute/work/sdk-packages ./sdk/python
```

Node tgz 仅包含 package.json、backend.mjs、backend.d.mts、README.md。根导出和 `/backend` 导出指向同一 ESM 实现；类型从匹配的 .d.mts 解析。内部路径和 CommonJS require 不在当前契约内。Python wheel 为 py3-none-any，包含 __init__.py、_client.py、py.typed 及 dist-info 元数据；依赖声明为 HTTPX 0.28.1。包内 README 自带最小使用方式和当前限制。

## 安装验证

`tests/verify-sdk-packages.py` 接受已构建产物，核对归档内容/源码 hash/版本/依赖，再建立全新的 npm consumer 和 Python venv。npm 使用本地 tgz 离线安装并禁止 install scripts；Python 从提供的离线 wheelhouse 完整解析依赖安装到 venv。校验实际 import 路径，consumer 中不放 SDK 源码目录。Node 合同只将 SDK 的相对 import 改为公开包名，Python 合同直接使用安装后的包名，测试主体保持原样。

```sh
python tests/verify-sdk-packages.py \
  --project /absolute/project \
  --node-archive /absolute/work/sdk-packages/remote-paint-session-client-0.0.0-dev.0.tgz \
  --python-wheel /absolute/work/sdk-packages/remote_paint_session-0.0.0.dev0-py3-none-any.whl \
  --wheelhouse /absolute/work/python-wheelhouse \
  --pip-tooling /absolute/work/python-pip-tooling \
  --tsc /absolute/work/node_modules/typescript/bin/tsc \
  --mypy-tooling /absolute/work/python-mypy-tooling \
  --output /absolute/work/fresh-sdk-package-verification
```

output 必须是新目录，不会覆盖已有结果。pip-tooling 中需有可由当前 Python 导入的 pip（本轮固定25.3）；wheelhouse 放 HTTPX 及其完整依赖的兼容 wheel。TypeScript 使用5.9.3；可选 mypy-tooling 固定1.19.1且须匹配当前Python/平台。未提供 mypy 时会明确记录没有执行安装包的 Python 类型检查；Node 类型检查始终执行。源码已接受的 Python 类型合同另有证据。

每一阶段保留原始日志、实际退出码及超时状态。验证包含原72项 Node/HTTP/SQLite合同加2项包导出合同，Python16项合同；真实回环链路覆盖首次受理响应丢失后的同键重试、一个资源分配、租户隔离、查询、释放及子进程回收。TypeScript 通过安装后的 exports 查找类型；mypy 使用 venv 的 PEP561发现机制，保留应拒绝的缺少幂等键、混用ID、修改结果、替换请求等反向用例。归档检查不允许额外文件、符号链接或 SDK 源码回退。

这些是纯客户端与明确 provider 夹具的合同。Native provider、真实显示端 read/control角色、短时Viewer票据、浏览器嵌入、完整长任务事件、跨版本滚动升级及公开发布仍分别待验收。Node仅验证Node22/26的ESM，Python运行范围按实际平台/版本记录；没有将纯Python wheel或平台无关源代码解释为所有架构/版本均已验证。

相关规则来自 [npm包文件与导出](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)、[setuptools数据文件](https://setuptools.pypa.io/en/latest/userguide/datafiles.html)及[mypy已安装包发现](https://mypy.readthedocs.io/en/stable/installed_packages.html)。
