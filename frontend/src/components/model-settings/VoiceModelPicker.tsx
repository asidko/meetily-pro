'use client';

import { VOICE_LOCKED_REASON, useModelSelection } from '@/hooks/useModelSelection';
import { SPEECH_PROVIDERS, type Catalog } from '@/lib/model-catalog';
import { ModelPicker } from './ModelPicker';

interface VoiceModelPickerProps {
  catalog: Catalog;
  onSetUp: () => void;
}

export function VoiceModelPicker({ catalog, onSetUp }: VoiceModelPickerProps) {
  const { voice, chooseVoiceModel, voiceLocked } = useModelSelection();

  return (
    <ModelPicker
      catalog={catalog}
      providers={SPEECH_PROVIDERS}
      value={voice}
      onChange={chooseVoiceModel}
      emptyText="No speech model yet"
      setUpText="Download one or add an API key in Providers"
      onSetUp={onSetUp}
      disabled={voiceLocked}
      disabledReason={VOICE_LOCKED_REASON}
    />
  );
}
