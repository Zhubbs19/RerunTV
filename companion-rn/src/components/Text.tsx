import { Text as RNText, type TextProps } from 'react-native';

// Honours the system font size but caps the growth: at the largest accessibility
// sizes the dense all-caps button labels would otherwise overflow their keys.
export function Text(props: TextProps) {
  return <RNText maxFontSizeMultiplier={1.3} {...props} />;
}
