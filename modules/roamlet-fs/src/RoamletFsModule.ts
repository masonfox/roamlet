import { requireNativeModule } from 'expo';

import type { RoamletFsNativeModule } from './RoamletFs.types';

export default requireNativeModule<RoamletFsNativeModule>('RoamletFs');
