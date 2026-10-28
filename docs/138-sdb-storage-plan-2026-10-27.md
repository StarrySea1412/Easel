# 138新增sdb挂载与容器存储迁移方案

## 已核对的现场状态

2026-10-27只读检查：系统盘sda为40GiB，根分区是ext4的sda2；新增`/dev/sdb`为60GiB / 64424509440字节QEMU磁盘，没有分区、文件系统签名、挂载点或设备holder。无签名不等于完整证明磁盘没有历史数据，格式化必须明确授权。主机`/data`尚不存在。

Docker使用`io.containerd.snapshotter.v1`。实际占用为`/var/lib/containerd` 24914186240字节、`/var/lib/docker` 923578368字节；源码发行目录约1.9GB。当前有37个运行容器，包含Easel、AI-skills、充值等其他项目。仅改Docker的data-root不会迁走containerd的大部分镜像数据。

已按用户授权清理未使用构建缓存约2.16GB，旧备份另经本机与服务器哈希一致后转存；当前服务和回滚镜像受保护。聊天0.14.3补丁独立上线，不等待此磁盘方案。

## 建议实施方案

1. 用户明确授权后，再次核对sdb设备容量、无分区/签名且不是根盘；创建GPT和一个ext4分区，标签`storage138`，挂到`/data`。使用分区UUID写入fstab，保留fstab原件和完整执行回执。
2. 将`/var/lib/docker`复制到`/data/docker`，`/var/lib/containerd`复制到`/data/containerd`。安装当前缺少的发行版rsync，使用`-aHAXx --numeric-ids`保留权限、所有者、硬链接、ACL及扩展属性，跳过运行中的嵌套挂载；首次预复制时服务可继续运行。
3. 记录原运行容器与健康状态，安排全机容器短暂停机，停止Docker及containerd，执行最终同步和差异核对。充值、AI-skills和其他容器项目同样会受此停机影响。
4. 通过bind mount继续提供原来的`/var/lib/docker`和`/var/lib/containerd`路径，服务无需改业务数据路径；fstab记录持久绑定，为Docker/containerd加入`RequiresMountsFor`，防止新盘未挂载时误写系统盘。
5. 重启原运行容器，逐项核对镜像、卷、健康状态及原有HTTP入口，验证Easel登录、版本和聊天；以rsync校验确认新副本完整后，再释放系统盘上的旧副本。配置备份与回滚指令保留，业务数据只做核对后的迁移，不清空卷。

初始化磁盘只涉及sdb，不能对sda运行分区/格式化命令。正式执行前须核对上次检查后磁盘状态未变化。按本次占用测算，迁移两个容器存储目录可从系统盘释放约24GiB；应用通过宿主机bind mount保存的`/home/ubuntu/easel-data`等目录暂不移动。

## 已授权范围与回滚

用户已在具体方案询问中选择“同意格式化并迁移容器存储（推荐）”，明确授权格式化60GiB sdb、ext4挂载`/data`、迁移Docker与containerd，以及全机容器短暂停机。无需重复确认；先完成Easel 0.14.3正式上线，再记录其他项目HTTP/容器基线并迁移，最后验收和释放旧副本。当前实施结果在执行完成后追加。

切换前保留原fstab、systemd配置、容器清单和原目录；校验或启动失败时撤销bind mount与新配置，恢复原路径并启动原容器。原副本释放之后，仍可在停机窗口从新盘复制回原盘进行反向迁移。不能仅以mount成功宣称业务已恢复。
