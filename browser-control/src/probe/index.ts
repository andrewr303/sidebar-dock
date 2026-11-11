// The probe as a string constant, evaluated once per isolated world.
import { probeMain } from './source';

export type {
  ComboFacts,
  EditorFacts,
  EditorFamily,
  FileInfo,
  FileInputFacts,
  FormFacts,
  GuardReport,
  GuardStep,
  HitVerdict,
  NativeFacts,
  NavigationTarget,
  Obstruction,
  OptionResult,
  PageFacts,
  PopupFacts,
  PopupOptionFacts,
  ProbeApi,
  ProbeState,
  ScrollInfo,
  SelectedOption,
  SliderAria,
} from './source';

export const PROBE_WORLD_NAME = 'nanobrowser-probe';

/** Evaluated in the isolated world; defines globalThis.__nbProbe there. */
export const PROBE_SOURCE = `(${probeMain.toString()})();`;
