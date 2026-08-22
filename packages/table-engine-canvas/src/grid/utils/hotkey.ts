import { Key as KeyCode } from 'ts-keycode-enum';

export const isPrintableKey = (event: KeyboardEvent) => {
  const { keyCode } = event;
  const { metaKey, ctrlKey } = event;

  if (metaKey || ctrlKey || keyCode === KeyCode.Space) return false;
  return (
    (keyCode >= KeyCode.A && keyCode <= KeyCode.Z) ||
    (keyCode >= KeyCode.ClosedParen && keyCode <= KeyCode.OpenParen) ||
    (keyCode >= KeyCode.Numpad0 && keyCode <= KeyCode.Numpad9) ||
    (keyCode >= KeyCode.SemiColon && keyCode <= KeyCode.Tilde) ||
    (keyCode >= KeyCode.OpenBracket && keyCode <= KeyCode.Quote) ||
    (keyCode >= KeyCode.Multiply && keyCode <= KeyCode.Divide) ||
    keyCode === 61 || // Firefox: Equal/Plus key
    keyCode === 173 || // Firefox: Minus key
    ((keyCode === 229 || keyCode === 0) && event.key !== 'Shift') // 229: IME composition; 0: Firefox unidentified
  );
};

export const isNumberKey = (keyCode: number) => {
  return (
    (keyCode >= KeyCode.ClosedParen && keyCode <= KeyCode.OpenParen) ||
    (keyCode >= KeyCode.Numpad0 && keyCode <= KeyCode.Numpad9)
  );
};
