import { Redirect, Tabs } from 'expo-router';
import { TabBar } from '../../components/TabBar';
import { useBox } from '../../lib/session';
import { color } from '../../theme';

export default function TabsLayout() {
  const { session } = useBox();
  if (!session) return <Redirect href="/pair" />;
  return (
    <Tabs screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: color.surface } }} tabBar={(props) => <TabBar {...props} />}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="guide" />
      <Tabs.Screen name="lineup" />
      <Tabs.Screen name="more" />
    </Tabs>
  );
}
