"""Explain collector failures without guessing that an account logged out."""
import os
import re


def collection_failure(stderr: str, *, deployment_mode: str | None = None) -> tuple[int, str]:
    text = stderr or ''
    mode = os.environ.get('EASEL_DEPLOYMENT_MODE', '') if deployment_mode is None else deployment_mode
    deployed = mode in {'production', 'isolated-test'}
    module = re.search(r"ModuleNotFoundError: No module named ['\"]([^'\"]+)['\"]", text)
    if module:
        bundled = module.group(1) in {'account_evidence', 'account_stats', 'login_state', 'publish_receipt'}
        if deployed:
            message = ('服务端采集组件加载失败，请由维护者检查部署镜像中的脚本完整性并更新镜像后重试。'
                       if bundled else '服务端采集环境缺少依赖，请由维护者检查部署镜像；系统依赖或只读目录中的组件需更新镜像后重试。')
        else:
            message = ('本地采集组件加载失败，请检查当前安装的脚本目录是否完整后重试。'
                       if bundled else '本地采集环境缺少依赖，请到设置中的环境检查修复后重试。')
        return 500, message + ' 已保留原有数据，当前错误不能判断账号是否登录。'
    if any(marker in text.lower() for marker in ("executable doesn't exist", 'browser executable', 'playwright install')):
        message = ('服务端采集浏览器未就绪，请由维护者检查镜像中的浏览器与依赖；只读目录中的组件需更新镜像后重试。'
                   if deployed else '采集浏览器未就绪，请到设置中的环境检查修复浏览器后重试。')
        return 500, message + '已保留原有数据。'
    if any(marker in text.lower() for marker in ('timeout', 'timed out', 'err_connection', 'connectionerror', 'sslerror', 'proxyerror')):
        return 502, '采集连接失败或超时，请检查网络和代理后重试。已保留原有数据，登录状态尚未确认。'
    return 502, '采集未返回有效数据，请重试或检查采集运行记录。已保留原有数据，不能据此判定未登录或平台改版。'
