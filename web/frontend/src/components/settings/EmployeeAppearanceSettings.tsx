import { useId, useState } from 'react';
import {
  DEFAULT_EMPLOYEE_APPEARANCES, readEmployeeAppearances, saveEmployeeAppearances,
  type EmployeeAppearance,
} from '../../lib/employeeAppearance';
import '../../styles/employee-appearance.css';

/** Animal portrait preview; the office remains the full 3D view. */
function EmployeePortrait({ card }: { card: EmployeeAppearance }) {
  return <svg viewBox="0 0 120 120" aria-hidden="true" className="employee-card__portrait" data-species={card.species}>
    <circle cx="60" cy="60" r="57" fill={card.shirtColor} opacity=".1" />
    <path d="M27 115v-16q0-21 33-21t33 21v16Z" fill={card.shirtColor} />
    {card.species === 'rabbit' ? <g>
      <ellipse cx="44" cy="26" rx="11" ry="24" transform="rotate(-12 44 26)" fill={card.skinColor} />
      <ellipse cx="76" cy="26" rx="11" ry="24" transform="rotate(12 76 26)" fill={card.skinColor} />
      <ellipse cx="44" cy="25" rx="5" ry="17" transform="rotate(-12 44 25)" fill={card.hairColor} opacity=".5" />
      <ellipse cx="76" cy="25" rx="5" ry="17" transform="rotate(12 76 25)" fill={card.hairColor} opacity=".5" />
    </g> : card.species === 'bear' ? <g>
      <circle cx="34" cy="34" r="14" fill={card.skinColor} /><circle cx="86" cy="34" r="14" fill={card.skinColor} />
      <circle cx="34" cy="34" r="7" fill={card.hairColor} /><circle cx="86" cy="34" r="7" fill={card.hairColor} />
    </g> : <g>
      <path d={card.species === 'fox' ? 'M31 47 27 9 53 34ZM67 34 93 9 89 47Z' : 'M31 47 29 17 52 35ZM68 35 91 17 89 47Z'} fill={card.skinColor} />
      <path d="m35 36-2-12 12 11Zm40-1 12-11-2 12Z" fill={card.hairColor} />
    </g>}
    {card.species === 'fox' ? <path d="M29 48q0-20 31-20t31 20l-8 22-23 16-23-16Z" fill={card.skinColor} /> : <ellipse cx="60" cy="57" rx="30" ry="28" fill={card.skinColor} />}
    <path d="m53 32 7 9 7-9" fill="none" stroke={card.hairColor} strokeWidth="4" strokeLinecap="round" />
    {card.species === 'fox' ? <path d="m34 59 26 9 26-9-9 16-17 11-17-11Z" fill="#FFF4DD" /> : <ellipse cx="60" cy="70" rx="15" ry="11" fill="#FFF4DD" />}
    <circle cx="49" cy="55" r="3" fill="#363431" /><circle cx="71" cy="55" r="3" fill="#363431" />
    <path d="M56 66q4-3 8 0l-4 5Z" fill={card.hairColor} />
    <path d="M60 71v3m-6 0q3 5 6 0 3 5 6 0" fill="none" stroke="#725442" strokeWidth="1.7" strokeLinecap="round" />
    {card.species === 'cat' && <path d="m39 65-14-3m14 8-14 1m56-6 14-3m-14 8 14 1" fill="none" stroke={card.hairColor} strokeWidth="1.5" strokeLinecap="round" />}
    <path d="m43 90 17 10 17-10" fill="none" stroke="#fff" opacity=".5" strokeWidth="2" />
    <ellipse cx="32" cy="104" rx="8" ry="11" fill={card.skinColor} /><ellipse cx="88" cy="104" rx="8" ry="11" fill={card.skinColor} />
    {card.accessory === 'glasses' && <g fill="none" stroke="#424440" strokeWidth="2"><rect x="41" y="49" width="17" height="13" rx="5" /><rect x="62" y="49" width="17" height="13" rx="5" /><path d="M58 53h4M35 51h6m38 0h6" /></g>}
    {card.accessory === 'headset' && <g fill="none" stroke="#505957" strokeWidth="4"><path d="M32 56v-9a28 28 0 0 1 56 0v16q0 9-15 9" /><path d="M32 51v13m56-13v13" strokeWidth="7" strokeLinecap="round" /><path d="M71 72h5" strokeLinecap="round" /></g>}
  </svg>;
}

export default function EmployeeAppearanceSettings() {
  const [cards, setCards] = useState<EmployeeAppearance[]>(() => readEmployeeAppearances().map(card => ({ ...card })));
  const [baseline, setBaseline] = useState(() => JSON.stringify(cards));
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const prefix = useId();
  const dirty = JSON.stringify(cards) !== baseline;
  const change = (id: string, patch: Partial<EmployeeAppearance>) => {
    setCards(current => current.map(card => card.id === id ? { ...card, ...patch } : card));
    setMessage('');
  };
  const save = () => {
    try {
      const saved = saveEmployeeAppearances(cards);
      const normalized = readEmployeeAppearances().map(card => ({ ...card }));
      setCards(normalized);
      setBaseline(JSON.stringify(normalized));
      setError(!saved);
      setMessage(saved ? '员工角色卡已保存，办公室将使用新的展示形象。' : '当前窗口已应用，但未能保存到本机。原始数据已保留；请保留本页并使用页面顶部的存储提示处理。');
    } catch (cause) {
      setError(true);
      setMessage(cause instanceof Error ? cause.message : '角色卡校验失败，请检查输入。');
    }
  };
  return <section className="employee-settings" aria-labelledby={`${prefix}-title`}>
    <header className="employee-settings__heading"><div>
      <span className="employee-settings__eyebrow">OFFICE CAST</span>
      <h2 id={`${prefix}-title`}>员工角色卡</h2>
      <p>为办公室里的小动物搭配形象，让每位伙伴更容易辨认。</p>
    </div><span className="employee-settings__count">6 个岗位 · 1 个通用形象</span></header>
    <div className="employee-settings__scope">
      <strong>仅改变展示</strong>
      <p>显示名、岗位与外观不会修改模型提示词、权限或执行行为。真实 Agent 默认使用通用形象，可在员工详情中手动绑定角色卡；后台身份和任务仍按真实记录显示。</p>
    </div>
    <form onSubmit={event => { event.preventDefault(); save(); }}>
      <div className="employee-settings__grid">
        {cards.map((card, index) => <article className="employee-card" key={card.id} aria-label={`${DEFAULT_EMPLOYEE_APPEARANCES[index].role}角色卡`}>
          <div className="employee-card__head"><EmployeePortrait card={card} /><div><span className="employee-card__slot">{card.id === 'generic' ? '实时协作默认形象' : `岗位 ${String(index + 1).padStart(2, '0')}`}</span><h3>{card.name || '未命名员工'}</h3><p>{card.role || '显示岗位'}</p></div></div>
          <div className="employee-card__fields">
            <label>显示名<input value={card.name} maxLength={24} required onChange={event => change(card.id, { name: event.target.value })} /></label>
            <label>显示岗位<input value={card.role} maxLength={40} required onChange={event => change(card.id, { role: event.target.value })} /></label>
          </div>
          <div className="employee-card__colors">{([
            ['shirtColor', '服装'], ['hairColor', '点缀色'], ['skinColor', '毛色'],
          ] as const).map(([key, label]) => <label key={key}><input type="color" value={card[key]} aria-label={`${card.name || card.id}${label}颜色`} onChange={event => change(card.id, { [key]: event.target.value })} /><span>{label}</span><code>{card[key].toUpperCase()}</code></label>)}</div>
          <div className="employee-card__fields">
            <label>动物种类<select value={card.species} onChange={event => change(card.id, { species: event.target.value as EmployeeAppearance['species'] })}><option value="cat">小猫</option><option value="rabbit">兔子</option><option value="fox">狐狸</option><option value="bear">小熊</option></select></label>
            <label>配饰<select value={card.accessory} onChange={event => change(card.id, { accessory: event.target.value as EmployeeAppearance['accessory'] })}><option value="none">无配饰</option><option value="glasses">眼镜</option><option value="headset">耳机</option></select></label>
          </div>
        </article>)}
      </div>
      <div className="employee-settings__actions">
        <p>{dirty ? '有尚未保存的形象修改' : '形象配置保存在当前浏览器'}</p>
        <button type="button" className="btn btn-sm" onClick={() => { setCards(DEFAULT_EMPLOYEE_APPEARANCES.map(card => ({ ...card }))); setMessage('已载入默认角色卡，点击保存后应用。'); setError(false); }}>恢复默认</button>
        <button type="submit" className="btn btn-sm btn-primary">保存角色卡</button>
      </div>
      {message && <p className={`employee-settings__message${error ? ' is-error' : ''}`} role={error ? 'alert' : 'status'}>{message}</p>}
    </form>
  </section>;
}
