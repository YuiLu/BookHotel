import { schema } from '../src/config.js';
import { DEFAULT_HOTEL_CODE as HOTEL } from '../src/profiles.js';
export const stay={checkIn:'2027-01-03',checkOut:'2027-01-04'};
export const candidate={hotelCode:HOTEL,stay,planCode:'PL00028608',planName:'スタンダードプラン',roomCode:'RM00010240',roomName:'次の間タイプ和室',totalJpy:85800};
export function config(overrides={}) {
  return schema.parse({version:1,stays:[stay],guests:{adults:2},filters:{maxTotalJpy:100000,extraTaxBudgetJpy:300},checkout:{mode:'monitor'},...overrides});
}
export function quote(hotelCode=HOTEL,questions=[{code:8153,formType:'SELECT_ONE',title:'交通手段',required:true}]) {
  return {candidateSet:{hotelCode,grandTotalCharge:85800,
    paymentMethods:[{type:'CREDIT_CARD',agent:'JBI',disabled:false}],
    reservations:[{hotelCode,planCode:candidate.planCode,checkInDate:stay.checkIn,checkOutDate:stay.checkOut,stays:1,
      roomTypes:[{roomTypeCode:candidate.roomCode,rooms:[{lodgerTypeGenderBreakdowns:[{lodgerType:'ADULT',numberOfLodgers:2}]}]}],
      totalCharge:85800,options:[],couponDiscounts:[],adjustmentFee:0,
      cancellationPolicyDetails:{content:'TEST cancellation policy',rate:{'-1':100,'0':100,'1':50,'7':20}},
      questionForms:questions}]}};
}
export function searchData() {
  return {resultCount:1,pagingCount:10,planDetailResources:[{planCode:candidate.planCode,planTitle:candidate.planName,
    memberLimit:'0',dayuseSearch:false,dynamicPackageCheckEnable:false,referencePrice:42900,
    roomSearchResults:[{combinationFlg:'N',planPrice:'85,800',planPriceText:'合計',
      roomSearchResults:[{roomTypeCode:candidate.roomCode,roomTypeName:candidate.roomName}]}]}]};
}
