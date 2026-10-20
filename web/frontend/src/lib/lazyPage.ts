import { createElement, lazy, Suspense, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { PageBoundary, PageLoading } from '../components/LazyPage';
import type { PageFailureStage } from './pageFailure';

type Loader<Props extends object> = () => Promise<{ default: ComponentType<Props> }>;

/** Replace a rejected lazy promise on retry, while retaining App's controllers. */
export function createLazyPage<Props extends object>(label: string, load: Loader<Props>) {
  return function DeferredPage(props: Props) {
    const stage = useRef<PageFailureStage>('render');
    const deferred = () => lazy(async () => {
      stage.current = 'module_load';
      const module = await load();
      stage.current = 'render';
      return module;
    });
    const [Loaded, setLoaded] = useState(deferred);
    const [attempt, setAttempt] = useState(0);
    const retry = () => {
      setLoaded(deferred);
      setAttempt(value => value + 1);
    };
    return createElement(PageBoundary, { key: attempt, label, onRetry: retry, getStage: () => stage.current },
      createElement(Suspense, { fallback: createElement(PageLoading, { label }) },
        createElement(Loaded, props)));
  };
}
