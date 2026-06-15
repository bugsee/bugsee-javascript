import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// NOTE: this package's tsconfig enables experimentalDecorators + emitDecoratorMetadata for the
// integration TEST's real-Nest DI (read by vitest/oxc). tsup logs a benign "emitDecoratorMetadata needs
// @swc/core" warning because of that flag, but the SOURCE uses no decorator syntax (`Catch()` is applied
// functionally), so the emitted dist is correct. @nestjs/* + rxjs stay external (peer deps).
export default defineConfig(baseConfig);
