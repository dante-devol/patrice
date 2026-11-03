import { SetMetadata } from '@nestjs/common';
import { ContractRoute } from './routes';

export const CONTRACT_META = 'patrice:contract';

/** Binds a controller handler to its entry in the contract (contract/routes.ts). */
export const Contract = (route: ContractRoute): MethodDecorator => SetMetadata(CONTRACT_META, route);
