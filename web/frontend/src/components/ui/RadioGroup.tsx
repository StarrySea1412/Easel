import { useRef } from 'react';
import type { AriaAttributes, KeyboardEvent, ReactNode } from 'react';
import './radio-group.css';

export interface RadioOption<T extends string> { value:T; label:ReactNode; ariaLabel?:string; disabled?:boolean }
export interface RadioGroupProps<T extends string> extends Pick<AriaAttributes,'aria-label'|'aria-labelledby'|'aria-describedby'> {
  value:T;
  options:readonly RadioOption<T>[];
  onChange:(value:T)=>void;
  disabled?:boolean;
  className?:string;
}

/** Connected single-choice buttons with one tab stop and standard radio navigation. */
export default function RadioGroup<T extends string>({value,options,onChange,disabled=false,className='',...aria}:RadioGroupProps<T>) {
  const buttons=useRef<(HTMLButtonElement|null)[]>([]);
  const enabled=options.map((option,index)=>disabled||option.disabled?-1:index).filter(index=>index>=0);
  const selected=options.findIndex(option=>option.value===value);
  const tabIndex=enabled.includes(selected)?selected:enabled[0];
  const choose=(index:number)=>{const option=options[index];if(disabled||!option||option.disabled)return;if(option.value!==value)onChange(option.value);};
  const onKeyDown=(event:KeyboardEvent<HTMLButtonElement>,index:number)=>{
    if(disabled||options[index]?.disabled||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)||!enabled.length)return;
    event.preventDefault();
    const current=enabled.indexOf(index);
    const next=event.key==='Home'?enabled[0]:event.key==='End'?enabled.at(-1)!:enabled[(current+(['ArrowRight','ArrowDown'].includes(event.key)?1:-1)+enabled.length)%enabled.length];
    buttons.current[next]?.focus({preventScroll:true});choose(next);
  };
  return <div className={`easel-radio-group ${className}`.trim()} role="radiogroup" aria-disabled={disabled||undefined} {...aria}>
    {options.map((option,index)=><button key={option.value} ref={node=>{buttons.current[index]=node;}} type="button" role="radio" value={option.value} className="easel-radio-option" aria-label={option.ariaLabel} aria-checked={option.value===value} disabled={disabled||option.disabled} tabIndex={index===tabIndex?0:-1} onClick={()=>choose(index)} onKeyDown={event=>onKeyDown(event,index)}>{option.label}</button>)}
  </div>;
}
