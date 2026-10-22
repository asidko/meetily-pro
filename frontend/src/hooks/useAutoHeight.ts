import { useEffect, useLayoutEffect, type RefObject } from 'react';

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function useAutoHeight(ref: RefObject<HTMLTextAreaElement>, value: string, maxHeight = Number.POSITIVE_INFINITY) {
  useBrowserLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
  }, [ref, value, maxHeight]);
}
