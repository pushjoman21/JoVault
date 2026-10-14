import { offset } from './native-host.mjs';

function mix(value) {
  let result = value | 0;
  for (let i = 0; i < 12; i++) {
    result = ((result << 5) - result + i) | 0;
  }
  return offset(result);
}

export { mix, mix as default };
