import { Children, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { AriaAttributes, KeyboardEvent, ReactNode, SelectHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import './select.css';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SelectProps extends Pick<AriaAttributes, 'aria-label' | 'aria-labelledby' | 'aria-describedby' | 'aria-invalid'> {
  id?: string;
  name?: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  title?: string;
}

/** Single-choice combobox. Focus stays on the trigger while navigating its listbox. */
export default function Select({ id, name, value, options, onChange, placeholder = '请选择', disabled = false, required = false, className = '', title, ...aria }: SelectProps) {
  const generatedId = useId();
  const triggerId = id || `select-${generatedId}`;
  const listId = `${triggerId}-options`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const searchRef = useRef({ text: '', time: 0 });
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0, maxHeight: 320 });
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];
  const expanded = open && !disabled && options.length > 0;

  function show(direction: 1 | -1 = 1) {
    if (disabled || !options.length) return;
    const enabled = options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
    setActiveIndex(selected && !selected.disabled ? selectedIndex : (direction === 1 ? enabled[0] : enabled.at(-1)) ?? -1);
    searchRef.current = { text: '', time: 0 };
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
    if (option.value !== value) onChange(option.value);
  }

  function move(direction: 1 | -1) {
    for (let step = 1; step <= options.length; step++) {
      const index = (activeIndex + direction * step + options.length) % options.length;
      if (!options[index].disabled) { setActiveIndex(index); return; }
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (event.key === 'Tab') { setOpen(false); return; }
    if (event.key === 'Escape') {
      if (expanded) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      if (!expanded) show(direction); else move(direction);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (!expanded) show();
      const enabled = options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
      setActiveIndex((event.key === 'Home' ? enabled[0] : enabled.at(-1)) ?? -1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!expanded) show(); else choose(activeIndex);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      const previous = now - searchRef.current.time < 700 ? searchRef.current.text : '';
      const query = `${previous}${event.key}`.toLocaleLowerCase();
      if (!expanded) show();
      searchRef.current = { text: query, time: now };
      // Repeating a letter cycles through matches, just like a native select.
      const repeated = [...query].every((letter) => letter === query[0]);
      const prefix = repeated ? query[0] : query;
      const from = expanded ? activeIndex : selectedIndex;
      for (let offset = repeated ? 1 : 0; offset < options.length + (repeated ? 1 : 0); offset++) {
        const index = (Math.max(from, 0) + offset) % options.length;
        const option = options[index];
        if (option && !option.disabled && option.label.toLocaleLowerCase().startsWith(prefix)) { setActiveIndex(index); break; }
      }
    }
  }

  useEffect(() => {
    if (disabled || !options.length) setOpen(false);
  }, [disabled, options.length]);

  useLayoutEffect(() => {
    if (!expanded) return;
    function updatePosition() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      if (rect.bottom < 0 || rect.top > viewportHeight) { setOpen(false); return; }
      const margin = 8;
      const gap = 6;
      const below = viewportHeight - rect.bottom - gap - margin;
      const above = rect.top - gap - margin;
      const upwards = below < 220 && above > below;
      const maxHeight = Math.max(80, Math.min(320, upwards ? above : below));
      const width = Math.max(0, Math.min(Math.max(rect.width, 240), viewportWidth - margin * 2));
      const popupHeight = Math.min(popupRef.current?.scrollHeight || maxHeight, maxHeight);
      setPosition({
        top: upwards ? Math.max(margin, rect.top - popupHeight - gap) : rect.bottom + gap,
        left: Math.max(margin, Math.min(rect.left, viewportWidth - width - margin)),
        width, maxHeight,
      });
    }
    updatePosition();
    const observer = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(updatePosition) : null;
    if (triggerRef.current) observer?.observe(triggerRef.current);
    if (popupRef.current) observer?.observe(popupRef.current);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popupRef.current?.contains(target)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const popup = popupRef.current;
    const option = optionRefs.current[activeIndex];
    if (!popup || !option) return;
    // Scroll only the options panel; never move the page or its containing form.
    const top = option.offsetTop;
    const bottom = top + option.offsetHeight;
    if (top < popup.scrollTop) popup.scrollTop = top;
    else if (bottom > popup.scrollTop + popup.clientHeight) popup.scrollTop = bottom - popup.clientHeight;
  }, [expanded, activeIndex]);

  return <>
    <button ref={triggerRef} id={triggerId} type="button" role="combobox" value={value} title={title}
      className={`easel-select ${expanded ? 'is-open' : ''} ${className}`.trim()}
      aria-expanded={expanded} aria-haspopup="listbox" aria-controls={expanded ? listId : undefined}
      aria-activedescendant={expanded && options[activeIndex] ? `${listId}-${activeIndex}` : undefined}
      aria-required={required || undefined} disabled={disabled} {...aria}
      onClick={() => expanded ? setOpen(false) : show()} onKeyDown={onKeyDown}
      onBlur={(event) => { if (!popupRef.current?.contains(event.relatedTarget as Node)) setOpen(false); }}>
      <span className="easel-select-icon" aria-hidden="true">{selected?.icon}</span><span className={`easel-select-value${selected ? '' : ' is-placeholder'}`}>{selected?.label || value || placeholder}</span>
      <svg className="easel-select-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {name && <input type="hidden" name={name} value={value} disabled={disabled} />}
    {expanded && createPortal(<div ref={popupRef} id={listId} role="listbox"
      aria-label={aria['aria-label']} aria-labelledby={aria['aria-labelledby'] || (!aria['aria-label'] ? triggerId : undefined)}
      className="easel-select-popup" style={position}>
      {options.map((option, index) => <div key={option.value} ref={(node) => { optionRefs.current[index] = node; }}
        id={`${listId}-${index}`} role="option" data-value={option.value} aria-selected={value === option.value} aria-disabled={option.disabled || undefined}
        className={`easel-select-option${index === activeIndex ? ' is-active' : ''}${value === option.value ? ' is-selected' : ''}${option.disabled ? ' is-disabled' : ''}`}
        onPointerMove={() => { if (!option.disabled) setActiveIndex(index); }}
        onMouseDown={(event) => event.preventDefault()} onClick={() => choose(index)}>
        {option.icon && <span className="easel-select-icon" aria-hidden="true">{option.icon}</span>}<span className="easel-select-option-copy"><span className="easel-select-option-label">{option.label}</span>{option.description && <span className="easel-select-option-description">{option.description}</span>}</span>
        {value === option.value && <svg className="easel-select-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>}
      </div>)}
    </div>, document.body)}
  </>;
}

function optionText(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{children?:ReactNode}>(child) ? optionText(child.props.children) : String(child)).join('');
}
function childOptions(children: ReactNode, groupDisabled = false): SelectOption[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{children?:ReactNode;value?:string|number;disabled?:boolean}>(child)) return [];
    if (child.type === 'option') return [{value:String(child.props.value ?? optionText(child.props.children)),label:optionText(child.props.children),disabled:groupDisabled || child.props.disabled}];
    return childOptions(child.props.children,groupDisabled || child.props.disabled);
  });
}

/** Native option/event compatibility; the visible control always uses our listbox. */
export function NativeSelect({children,value,defaultValue,onChange,id,className,disabled,required,name,optionIcons,...props}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'multiple' | 'size'> & { optionIcons?: Record<string, ReactNode> }) {
  const nativeRef = useRef<HTMLSelectElement>(null);
  const generatedId=useId();
  const triggerId=id || `native-select-${generatedId}`;
  const errorId=`${triggerId}-error`;
  const [localValue,setLocalValue] = useState<string|undefined>(()=>defaultValue === undefined ? undefined : String(defaultValue));
  const [validationMessage,setValidationMessage] = useState('');
  const options=childOptions(children).map(option => ({ ...option, icon: optionIcons?.[option.value] }));
  const selectedValue=value === undefined ? localValue ?? options.find(option=>!option.disabled)?.value ?? '' : String(value);
  useEffect(()=>{
    if(disabled || !required || nativeRef.current?.validity.valid) setValidationMessage('');
  },[selectedValue,disabled,required]);
  return <>
    <Select id={triggerId} value={selectedValue} options={options} className={className} disabled={disabled} required={required} title={props.title}
      aria-label={props['aria-label']} aria-labelledby={props['aria-labelledby']} aria-describedby={[props['aria-describedby'],validationMessage?errorId:undefined].filter(Boolean).join(' ') || undefined} aria-invalid={validationMessage?true:props['aria-invalid']}
      onChange={next=>{const native=nativeRef.current;if(native){native.value=next;native.dispatchEvent(new window.Event('change',{bubbles:true}));}}}/>
    <select {...props} ref={nativeRef} name={name} value={selectedValue} disabled={disabled} required={required} aria-hidden="true" tabIndex={-1} style={{display:'none'}}
      onInvalid={event=>{event.preventDefault();setValidationMessage('请选择一项。');document.getElementById(triggerId)?.focus({preventScroll:true});props.onInvalid?.(event);}}
      onChange={event=>{setLocalValue(event.target.value);setValidationMessage('');onChange?.(event);}}>{children}</select>
    {validationMessage&&<span id={errorId} role="alert">{validationMessage}</span>}
  </>;
}
