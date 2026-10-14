import {buyerBootstrapFixture} from '../test-support/buyer-mentorship-bootstrap-fixture';
import {buildBuyerMentorshipCheckoutRequest} from '../lib/mentorshipInstallmentCheckout';

function fixture(){const f=buyerBootstrapFixture();f.subscription.items.data[0].price.active=false;return f;}
test('accepts the archived inline price attached to the original held subscription',()=>{
  const f=fixture();expect(()=>buildBuyerMentorshipCheckoutRequest(f)).not.toThrow();
});
test.each(['amount','product','currency','interval','missingActive'])('archived inline price does not bypass %s validation',kind=>{
  const f=fixture(),p=f.subscription.items.data[0].price;
  if(kind==='amount')p.unit_amount=1;
  if(kind==='product')p.product='prod_other';
  if(kind==='currency')p.currency='eur';
  if(kind==='interval')p.recurring!.interval='year';
  if(kind==='missingActive')delete (p as Partial<typeof p>).active;
  expect(()=>buildBuyerMentorshipCheckoutRequest(f)).toThrow();
});
