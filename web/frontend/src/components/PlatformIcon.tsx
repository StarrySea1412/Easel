import xiaohongshu from '../assets/platforms/xiaohongshu.svg';
import kuaishou from '../assets/platforms/kuaishou.svg';
import channels from '../assets/platforms/weixin-channels.png';
import zhihu from '../assets/platforms/zhihu.svg';
import bilibili from '../assets/platforms/bilibili.svg';
import douyin from '../assets/platforms/douyin.png';
import wechat from '../assets/platforms/wechat.svg';

const PLATFORM_ICONS: Record<string, string> = {
  xiaohongshu, kuaishou, 'weixin-channels': channels, zhihu, bilibili, douyin, 'wechat-oa': wechat,
};

export default function PlatformIcon({ platform, name, className = 'platform-icon' }: {
  platform: string;
  name: string;
  className?: string;
}) {
  const file = PLATFORM_ICONS[platform];
  if (file) return <img className={className} src={file} alt={`${name}标志`} width={32} height={32} draggable={false} />;
  // Future unsupported platforms use a neutral symbol, never an invented brand.
  return <svg className={className} role="img" aria-label={name} viewBox="0 0 24 24" width={32} height={32} fill="none" stroke="currentColor" strokeWidth={1.5}>
    <circle cx={12} cy={12} r={9} /><ellipse cx={12} cy={12} rx={4} ry={9} /><path d="M3 12h18" />
  </svg>;
}
