import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { computeLayout, type LayoutInfo } from './layout';

// Current screen metrics: size class, one or two columns, readable content
// width after notch / gesture-bar insets. Re-evaluated on rotation and on
// split-screen or foldable resizes.
export function useLayout(): LayoutInfo {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return computeLayout(width, height, insets.left, insets.right);
}
