import { config } from './helpers.js';
export const triplaStay={checkIn:'2026-11-09',checkOut:'2026-11-10'};
export function triplaConfig(overrides={}) {
  return config({hotel:{engine:'tripla',code:'4398',name:'Ubuya',bookingUrl:'https://www.ubuya.co.jp/en/room/',lodgerTypeCodes:[0],questions:[]},
    stays:[triplaStay],filters:{maxTotalJpy:150000,extraTaxBudgetJpy:300,roomCodes:['20']},...overrides});
}
export function triplaData(stay=triplaStay) {
  return {rooms:[{room_type_code:'20',room_type_name:'附露天浴池的特别房(98㎡)【富士山景观/禁烟】',room_count:1,min_price:108000,
    room_plan:[{room_plan_code:'14572645-20-14098-4398',hotel_plan_code:'14572645',room_plan_name:'标准一晚住宿含两餐 - 时令自助餐',
      availability:'available',sign_in_required:false,only_visible_to_guest:false,total_price:108000,tax:10800,accommodation_tax:0,
      mcp_total_price:{cents:72818,currency_iso:'USD'},room_rate:[{date:stay.checkIn.replaceAll('-','/'),rate:118800}],
      inventory:1,is_no_refund:true,cancellation_free_deadline:'',payment_method:[{code:'credit_card',name:'信用卡支付'}],
      matched_search_criteria:{adults_count:2,children_count:0}}]}],mcp_currency:'USD',
    search_params:{checkin_date:stay.checkIn.replaceAll('-','/'),checkout_date:stay.checkOut.replaceAll('-','/')}};
}
