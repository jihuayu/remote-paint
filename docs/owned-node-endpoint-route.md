# 自有 Node 端点的实际容器路由

实际运行固定Engine、DockerSessionProvider、私有attach代理、SessionRegistry、ViewerAccess和已安装后端SDK，创建4个新命名空间。直接请求Engine绑定的逐网络IPv4：HTTP4175返回明确Node夹具标识，WS4176验证派生密钥和固定Origin；错误密钥/Origin均403。容器没有发布宿主端口。

只在隔离execution project中，把canonical worker替换为带显式注释的Node ABI shim，导入独立命名的测试适配器；生产worker原文件未改，两个哈希均记录。合格Linux broker只复制到该执行项目canonical路径、真实浏览器目录指纹固定，但本夹具不启动二者。固定入口路径/端口ABI及生产所有归属/指纹/见证/网络检查均保留，没有把Node版本当作Native运行证据。

真实公开ticket代理同时连接readonly/controller，核对身份、版本和角色能力过滤。实际安装的后端SDK负责HTTP创建/查询/释放，没有源码SDK回退。首会话释放时，测试只在真实network请求已完成后暂存其结果；新解析立即拒绝，迟到结果也不能返回密钥，两公开连接关闭。新会话在Docker重用同一IP后拒绝旧密钥。随后实际Registry TTL到期和精确拥有容器的外部删除均传播关闭；最后一例采用container-absent退役证明。

实际根Node退出0，4/4会话完成退役；前三个container-removed，最后一个container-absent。读取真实Linux私有PID namespace见证、绑定Engine StartedAt的持久journal并独立重新打开，4条均retired。精确CID过滤再次确认4容器均消失，5个已知宿主Node/attach PID全部ESRCH；保留SQLite、见证、退役与HTTP/WS范围收据。产物扫描未发现已知流/API密钥，密钥不归档。

生产运行文件和既有完整测试输入与924文件检查点逐字节一致；新增的是两个opt-in脚本。精确继承双平台938项完整JS回归（Mac923通过15跳过、Linux932通过6跳过）及77 Node/16 Python安装合同、严格TSC和Mac Mypy；没有虚构新的完整单元回归或包安装。此次新脚本完成Mac宿主与Linux实际Node执行，证据只支持本次Node路由与所列生命周期。

下一步使用真正canonical Native worker与冻结合格broker，验证公开SDK像素、Native健康丢失传播、TTL/取消/EOF/恢复及完整namespace退役。此前其他测试的恢复证据不能替本次覆盖全部恢复故障矩阵。全部Agent/CDP栅栏、N1轻微丢包/物理时延和原8小时增长仍未完成。41项9/15/17、原8小时失败与192MiB门槛保持，未自动重跑8小时、强制浏览器GC、改演示/采样器或暂存提交推送。见[范围收据](evidence/owned-node-endpoint-route.json)。
