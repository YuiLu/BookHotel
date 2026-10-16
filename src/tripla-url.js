export const TRIPLA_API_ORIGIN='https://concierge.tripla.ai';
export const TRIPLA_WIDGET_ORIGIN='https://bw.tripla.ai';
export const triplaDate=date=>date.replaceAll('-','/');

export function triplaUrl(stay,guests,hotel,{roomCode,planCode}={}) {
  if(hotel.engine!=='tripla')throw new Error('HOTEL_ENGINE_MISMATCH');
  const u=new URL(hotel.bookingUrl);
  if(u.protocol!=='https:'||u.username||u.password)throw new Error('UNTRUSTED_PAGE');
  // Use the hotel's official wrapper so its widget creates a fresh anonymous session.
  for(const key of ['room_type_code','room_type_codes','hotel_plan_code','room_plan_code'])u.searchParams.delete(key);
  for(const [key,value] of Object.entries({tripla_booking_widget_open:'search',locale:'zh-CN',
    checkin:triplaDate(stay.checkIn),checkout:triplaDate(stay.checkOut),adults:String(guests.adults),
    children:'0',rooms:'1',currency:'JPY',mcp_currency:'JPY'}))u.searchParams.set(key,value);
  if(roomCode)u.searchParams.set('room_type_code',roomCode);
  if(planCode)u.searchParams.set('hotel_plan_code',planCode);
  return u.href;
}

export function triplaRoomsUrl(base,stay,guests,roomCodes=[]) {
  const u=new URL(base);
  if(u.origin!==TRIPLA_API_ORIGIN||!/^\/book\/hotels\/\d+\/rooms$/.test(u.pathname))throw new Error('UNTRUSTED_SEARCH_URL');
  // Do not carry query-session identifiers, previous filters or children tiers across dates.
  u.search='';
  for(const [key,value] of Object.entries({'rooms[][checkin_date]':triplaDate(stay.checkIn),
    'rooms[][checkout_date]':triplaDate(stay.checkOut),'rooms[][adults]':String(guests.adults),
    'rooms[][children]':'0',order:'recommended',is_day_use:'false',is_including_occupied:'false',
    bookable:'true',currency:'JPY',mcp_currency:'JPY',type:'rooms',mcp_locale:'zh-CN'}))u.searchParams.set(key,value);
  for(const code of roomCodes)u.searchParams.append('room_type_codes[]',code);
  return u.href;
}
