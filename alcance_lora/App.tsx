import React, { useState } from 'react';
import { ScreenName } from './types';
import { HomeScreen } from './screens/HomeScreen';
import { MapScreen } from './screens/MapScreen';
import { DatabaseScreen } from './screens/DatabaseScreen';
import { useRangeSession } from './hooks/useRangeSession';

const App: React.FC = () => {
  const [screen, setScreen] = useState<ScreenName>(ScreenName.HOME);
  const s = useRangeSession();

  return (
    <div className="w-full min-h-screen bg-background-dark text-white">
      {screen === ScreenName.DATABASE ? (
        <DatabaseScreen onBack={() => setScreen(ScreenName.HOME)} />
      ) : screen === ScreenName.MAP ? (
        <MapScreen
          samples={s.samples}
          origin={s.origin}
          recording={s.recording}
          fix={s.fix}
          live={s.live}
          serialConnected={s.serialConnected}
          telemetryAgeMs={s.telemetryAgeMs}
          idleDetail={s.usbInfo}
          onBack={() => setScreen(ScreenName.HOME)}
        />
      ) : (
        <HomeScreen
          live={s.live}
          connection={s.connection}
          error={s.error}
          samples={s.samples}
          origin={s.origin}
          recording={s.recording}
          lastSample={s.lastSample}
          fix={s.fix}
          gpsStatus={s.gpsStatus}
          periodMs={s.periodMs}
          onSetPeriodMs={s.setPeriodMs}
          serialConnected={s.serialConnected}
          telemetryAgeMs={s.telemetryAgeMs}
          transport={s.transport}
          fonte={s.fonte}
          onSetFonte={s.setFonte}
          onSetRate={s.setRate}
          onSetPower={s.setPower}
          onSetDomain={s.setDomain}
          cloud={s.cloud}
          cloudMessage={s.cloudMessage}
          onSyncNow={s.syncNow}
          usbInfo={s.usbInfo}
          usbPresent={s.usbPresent}
          onStart={s.start}
          onStop={s.stop}
          onClear={s.clear}
          onSetOriginHere={s.setOriginHere}
          onSendCommand={s.sendCommand}
          createFile={s.createFile}
          continueFile={s.continueFile}
          fileId={s.fileId}
          fileName={s.fileName}
          onLoadSession={s.loadSession}
          onOpenMap={() => setScreen(ScreenName.MAP)}
          onOpenDatabase={() => setScreen(ScreenName.DATABASE)}
        />
      )}
    </div>
  );
};

export default App;
