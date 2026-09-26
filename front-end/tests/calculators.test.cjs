const {test} = require('node:test');
const assert = require('node:assert/strict');
const calculator = require('../assets/js/calculators.js');

const deadline = changes => calculator.calculateDeadline({start:'2026-09-25',days:1,mode:'business',includeStart:false,postpone:false,excludedDates:[],...changes});
const execution = changes => calculator.calculateExecution({totalDays:365,completedDays:30,numerator:1,denominator:6,rounding:'ceil',...changes});
const monetary = changes => calculator.calculateMonetary({start:'2026-01-01',end:'2026-09-01',principal:'1000.00',factor:'1.05',interestMode:'none',...changes});
const labor = changes => calculator.calculateLabor({admission:'2020-01-01',termination:'2026-09-01',salaryBalance:'0',notice:'0',thirteenth:'0',vacationDue:'0',vacationProportional:'0',otherCredits:'0',deductions:'0',fgtsMode:'none',...changes});

test('business deadline excludes only weekends and supplied dates, with explicit initial-day rule',()=>{
  assert.equal(deadline().date,'2026-09-28');
  assert.equal(deadline({includeStart:true}).date,'2026-09-25');
  const excluded = deadline({excludedDates:'2026-09-28\n2026-09-29\n2026-09-28'});
  assert.equal(excluded.date,'2026-09-30');
  assert.equal(excluded.providedExclusions,2);
  assert.equal(excluded.skippedDays,4);
  // No hardcoded national or court holidays.
  assert.equal(deadline({start:'2026-09-04'}).date,'2026-09-07');
});

test('calendar days and final-day adjustment are distinct explicit choices',()=>{
  assert.equal(deadline({mode:'calendar'}).date,'2026-09-26');
  const adjusted = deadline({mode:'calendar',postpone:true,excludedDates:['2026-09-28']});
  assert.equal(adjusted.date,'2026-09-29');
  assert.equal(adjusted.adjustmentDays,3);
});

test('UTC date arithmetic handles leap days without DST or timezone drift',()=>{
  assert.equal(deadline({start:'2024-02-28',mode:'calendar'}).date,'2024-02-29');
  assert.equal(deadline({start:'2024-02-28',mode:'calendar',days:2}).date,'2024-03-01');
  assert.equal(deadline({start:'2026-03-07',mode:'calendar',days:2}).date,'2026-03-09');
});

test('invalid dates, unbounded loops and ambiguous choices are rejected',()=>{
  for(const changes of [{start:'2025-02-29'},{start:'1899-12-31'},{start:'2200-12-31'},
    {days:0},{days:-1},{days:Infinity},{days:'1e9'},{days:3661},{days:1.5},
    {mode:'anything'},{includeStart:'yes'},{postpone:undefined},{excludedDates:['2026-13-01']},
    {excludedDates:Array(501).fill('2026-09-28')}]) assert.throws(()=>deadline(changes));
});

test('penal tool uses supplied fraction and rounding without declaring legal eligibility',()=>{
  const rounded = execution();
  assert.equal(rounded.targetDays,61);
  assert.equal(rounded.remainingDays,31);
  assert.equal(rounded.arithmeticTargetReached,false);
  assert.equal(execution({rounding:'floor'}).targetDays,60);
  assert.equal(execution({rounding:'nearest'}).targetDays,61);
  assert.equal(execution({completedDays:100}).remainingDays,0);
  assert.equal(execution({completedDays:100}).arithmeticTargetReached,true);
  assert.equal('eligible' in rounded,false);
  for(const changes of [{completedDays:366},{totalDays:0},{numerator:2,denominator:1},
    {numerator:0},{denominator:0},{rounding:''},{totalDays:Infinity}]) assert.throws(()=>execution(changes));
});

test('monetary tool applies supplied factor with exact half-cent rounding and no default interest',()=>{
  const result=monetary();
  assert.equal(result.updatedCents,105000);
  assert.equal(result.interestCents,0);
  assert.equal(result.totalCents,105000);
  assert.equal(monetary({principal:'1.00',factor:'1.005'}).updatedCents,101);
  assert.equal(monetary({principal:'100.00',factor:'0.95'}).correctionCents,-500);
});

test('interest requires its rate, period count, unit and basis; dates do not generate periods',()=>{
  const input={interestMode:'simple',interestRate:'1',interestPeriods:2,interestBasis:'original',periodUnit:'month'};
  assert.equal(monetary(input).interestCents,2000);
  assert.equal(monetary({...input,interestBasis:'updated'}).interestCents,2100);
  assert.equal(monetary({...input,end:'2026-01-01'}).interestCents,2000);
  assert.equal(monetary({...input,interestMode:'compound'}).interestCents,2010);
  assert.equal(monetary({...input,interestMode:'compound',interestPeriods:0}).interestCents,0);
  assert.throws(()=>monetary({interestMode:'simple'}));
  assert.throws(()=>monetary({...input,interestPeriods:1.5}));
});

test('monetary invalid order, malformed amounts and excessive totals fail before presenting a result',()=>{
  for(const changes of [{start:'2026-09-02'},{end:'2026-02-30'},{principal:''},
    {principal:'12.345'},{principal:'1e5'},{principal:-1},{factor:0},{factor:Infinity},
    {principal:'1000000000',factor:1000},
    {interestMode:'compound',interestRate:100,interestPeriods:1200,interestBasis:'original',periodUnit:'year'}]) assert.throws(()=>monetary(changes));
});

test('labor composition never infers unused vacation, notice or FGTS deposits from dates',()=>{
  assert.equal(labor().netCents,0);
  const result=labor({salaryBalance:'1500.00',vacationDue:'400.00',vacationProportional:'300.00',deductions:'100.00'});
  assert.equal(result.grossCents,220000);
  assert.equal(result.netCents,210000);
  assert.equal(result.fgtsBaseCents,0);
  assert.equal(labor({salaryBalance:'1.10',notice:'2.20'}).grossCents,330);
  assert.equal(labor({deductions:'1.00'}).netCents,-100);
});

test('FGTS penalty uses documented base and explicit rate, without adding the balance to the total',()=>{
  const result=labor({fgtsMode:'penalty',fgtsBase:'1234.56',fgtsRate:'40'});
  assert.equal(result.fgtsPenaltyCents,49382);
  assert.equal(result.grossCents,49382);
  assert.equal(result.fgtsBaseCents,123456);
  assert.throws(()=>labor({fgtsMode:'penalty'}));
  assert.throws(()=>labor({salaryBalance:''}));
  assert.throws(()=>labor({admission:'2027-01-01'}));
  assert.throws(()=>labor({vacationDue:'1000000000',notice:'1000000000'}));
});

test('four semantic forms expose labelled inputs, explicit choices and announced results',()=>{
  const html=calculator.render();
  assert.equal((html.match(/<form /g)||[]).length,4);
  assert.equal((html.match(/data-calculator-result/g)||[]).length,4);
  for(const match of html.matchAll(/<(?:input|select|textarea)[^>]* id="([^"]+)"/g)) {
    assert.ok(html.includes(`for="${match[1]}"`),`Missing label for ${match[1]}`);
  }
  assert.ok(!html.includes('onclick='));
  assert.ok(!html.includes('IPCA (~'));
  assert.ok(!html.includes('ELEGÍVEL'));
});
