import { DReserveSearch } from './search.js';
import { TriplaSearch } from './tripla.js';

export function createSearch(context,config) {
  if(config.hotel.engine==='d-reserve')return new DReserveSearch(context,config);
  if(config.hotel.engine==='tripla')return new TriplaSearch(context,config);
  throw new Error('UNSUPPORTED_HOTEL_ENGINE');
}
