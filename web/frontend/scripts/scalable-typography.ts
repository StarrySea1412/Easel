import type { Plugin } from 'postcss';

const scale = 'var(--easel-font-scale, 1)';

/** Scale workspace typography at build/dev time; geometry and authored artifacts stay unchanged. */
export default function scalableTypography(): Plugin {
  return {
    postcssPlugin: 'easel-scalable-typography',
    Once(root) {
      root.walkDecls(/^(font-size|font|line-height)$/i, declaration => {
        if (declaration.value.includes('--easel-font-')) return;
        // Relative sizes already inherit the scaled font. Absolute px sizes need the preference.
        if (declaration.prop.toLowerCase() === 'font-size' && /[\d.]px\b/.test(declaration.value)) {
          declaration.value = `calc((${declaration.value}) * ${scale})`;
        } else {
          declaration.value = declaration.value.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?<![\w.-])(\d*\.?\d+)px\b/g,
            (token, quoted, size) => quoted ? token : `calc(${size}px * ${scale})`);
        }
      });
    },
  };
}
