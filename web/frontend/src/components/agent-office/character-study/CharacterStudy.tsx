import { useEffect, useRef, useState } from 'react';
import { createCharacterStudyRuntime } from './CharacterStudyRuntime';
import { STUDY_FURS, STUDY_PRESETS, STUDY_SWEATERS, STUDY_VIEWS, type StudyAppearance, type StudyPresetId, type StudyView } from './studyPresets';
import './character-study.css';

const APPEARANCE_KEY = 'easel.character-study.appearance.v1';
const DEFAULT_APPEARANCE: StudyAppearance = { fur: 'amber', sweater: 'sage' };
function readAppearance(): StudyAppearance {
  try {
    const value = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || 'null');
    return value && STUDY_FURS.some((item) => item.id === value.fur) && STUDY_SWEATERS.some((item) => item.id === value.sweater) ? value : DEFAULT_APPEARANCE;
  } catch { return DEFAULT_APPEARANCE; }
}

export interface CharacterStudyProps {
  /** Controlled role preview. All presets share the same editable skinned model. */
  preset?: StudyPresetId;
  onPresetChange?: (preset: StudyPresetId) => void;
  onClose?: () => void;
}

/** First asset/interaction study. This component intentionally has no live task API. */
export function CharacterStudy({ preset: controlledPreset, onPresetChange, onClose }: CharacterStudyProps) {
  const [localPreset, setLocalPreset] = useState<StudyPresetId>('writing');
  const preset = controlledPreset ?? localPreset;
  const [appearance, setAppearance] = useState<StudyAppearance>(readAppearance);
  const [savedAppearance, setSavedAppearance] = useState<StudyAppearance>(readAppearance);
  const [view, setView] = useState<StudyView>('work');
  const [paused, setPaused] = useState(false);
  const [stage, setStage] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<ReturnType<typeof createCharacterStudyRuntime>>(null);
  const current = STUDY_PRESETS.find((item) => item.id === preset) || STUDY_PRESETS[1];
  const changed = appearance.fur !== savedAppearance.fur || appearance.sweater !== savedAppearance.sweater;

  useEffect(() => {
    if (!host.current) return;
    let active = true;
    runtime.current = createCharacterStudyRuntime({ host: host.current, preset, appearance, paused, view,
      onReady: () => { if (active) setReady(true); },
      onStage: (value) => { if (active) setStage(value); },
      onError: (value) => { if (active) setError(value); },
    });
    return () => { active = false; runtime.current?.dispose(); runtime.current = null; };
    // The runtime owns one renderer; updates below preserve orbit, loaded asset and pose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { runtime.current?.setPreset(preset); setStage(0); }, [preset]);
  useEffect(() => { runtime.current?.setAppearance(appearance); }, [appearance]);
  useEffect(() => { runtime.current?.setPaused(paused); }, [paused]);
  useEffect(() => { runtime.current?.setView(view); }, [view]);

  function choosePreset(value: StudyPresetId) { setLocalPreset(value); onPresetChange?.(value); setView('work'); }
  function saveAppearance() {
    try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance)); setSavedAppearance({ ...appearance }); setMessage('样板形象已保存在此浏览器'); }
    catch { setMessage('浏览器存储不可用，当前预览仍然保留'); }
  }

  return <section className="character-study" aria-label="角色与岗位工位样板">
    <header className="character-study__header">
      <div><span className="character-study__eyebrow">STUDIO / CHARACTER STUDY 01</span><h2>每一份工作，都有自己的位置。</h2><p>从一个角色、一张桌子开始，把工作室做得更真实。</p></div>
      {onClose && <button type="button" className="character-study__close" onClick={onClose} aria-label="返回 Agent 工作室">返回工作室 <span aria-hidden="true">↗</span></button>}
    </header>
    <div className="character-study__layout">
      <div className="character-study__main">
        <div className="character-study__preset-switch" aria-label="切换岗位工位">
          {STUDY_PRESETS.map((item) => <button type="button" key={item.id} aria-pressed={preset === item.id} onClick={() => choosePreset(item.id)}><span>{item.title}</span><small>{item.subtitle}</small></button>)}
        </div>
        <div className="character-study__stage-wrap">
          <div className="character-study__stage" ref={host} />
          <div className="character-study__stage-label"><span className="character-study__dot" /> {current.title}工位 <span>01 / 猫角色样板</span></div>
          <div className="character-study__demo-label">动作演示 · 非后台运行</div>
          {(!ready || error) && <div className="character-study__fallback" role="status"><span>{error || '正在打开角色样板…'}</span></div>}
          <div className="character-study__viewbar" aria-label="检查角色视角">
            {STUDY_VIEWS.map((item) => <button type="button" key={item.id} aria-pressed={view === item.id} onClick={() => { setView(item.id); if (view === item.id) runtime.current?.setView(item.id); }}>{item.label}</button>)}
          </div>
          <span className="character-study__orbit-hint">拖动旋转 · 滚轮缩放</span>
        </div>
        <div className="character-study__playback">
          <button type="button" className="character-study__play" onClick={() => setPaused(!paused)} disabled={!ready || Boolean(error)} aria-label={paused ? '继续动作演示' : '暂停动作演示'}>{paused ? '▶' : 'Ⅱ'}</button>
          <div className="character-study__steps" aria-label="演示工作阶段">
            {current.stages.map((label, index) => <span key={label} className={stage === index ? 'is-current' : stage > index ? 'is-past' : ''}><i />{label}</span>)}
          </div>
          <button type="button" className="character-study__restart" onClick={() => runtime.current?.restart()} disabled={!ready || Boolean(error)}>重播</button>
        </div>
      </div>
      <aside className="character-study__inspector" aria-label="同模型形象编辑">
        <div className="character-study__identity"><div className="character-study__monogram" aria-hidden="true">E</div><div><h3>Easel</h3><span>工作室里的第一位成员</span></div></div>
        <div className="character-study__description"><span className="character-study__field-label">这张桌子，为{current.title}而设</span><p>{current.details}</p></div>
        <fieldset><legend>毛色</legend><div className="character-study__swatches">{STUDY_FURS.map((item) => <button type="button" key={item.id} aria-pressed={appearance.fur === item.id} onClick={() => { setAppearance({ ...appearance, fur: item.id }); setMessage(''); }}><i style={{ backgroundColor: item.color }} /><span>{item.label}</span></button>)}</div></fieldset>
        <fieldset><legend>针织衫</legend><div className="character-study__swatches">{STUDY_SWEATERS.map((item) => <button type="button" key={item.id} aria-pressed={appearance.sweater === item.id} onClick={() => { setAppearance({ ...appearance, sweater: item.id }); setMessage(''); }}><i style={{ backgroundColor: item.color }} /><span>{item.label}</span></button>)}</div></fieldset>
        <p className="character-study__edit-note">直接预览场景里的同一个角色。切换机位，检查坐姿、衣服和双手。</p>
        <div className="character-study__save-row"><button type="button" className="character-study__save" onClick={saveAppearance} disabled={!changed}>保存样板形象</button><button type="button" className="character-study__undo" disabled={!changed} onClick={() => { setAppearance({ ...savedAppearance }); setMessage('已还原上次保存的形象'); }}>撤销</button></div>
        <p className="character-study__message" role="status">{message || (changed ? '有未保存的形象调整' : '形象设置仅用于此样板')}</p>
        <div className="character-study__scope"><span>首轮可操作样板</span><p>原创蒙皮角色、可动手指和三种岗位工位。屏幕内容与动作均为演示，尚未连接真实任务。</p></div>
      </aside>
    </div>
  </section>;
}

export default CharacterStudy;
