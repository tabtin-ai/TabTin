declare module 'react-hammerjs' {
  import { Component } from 'react';
  interface HammerComponentProps {
    onTap?: (event: any) => void;
    onPan?: (event: any) => void;
    onPanStart?: (event: any) => void;
    onPanEnd?: (event: any) => void;
    onSwipe?: (event: any) => void;
    onPress?: (event: any) => void;
    options?: Record<string, any>;
    direction?: string;
    children?: React.ReactNode;
    [key: string]: any;
  }
  export default class Hammer extends Component<HammerComponentProps> {}
}
