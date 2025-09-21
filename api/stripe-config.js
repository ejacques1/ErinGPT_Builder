// api/stripe-config.js - Stripe integration for creator and customer subscriptions
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Content-Type, Authorization'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { action, ...data } = req.body;

    switch (action) {
      case 'create_creator_subscription':
        return await createCreatorSubscription(req, res, data);
      case 'create_connect_account':
        return await createConnectAccount(req, res, data);
      case 'create_customer_subscription':
        return await createCustomerSubscription(req, res, data);
      case 'verify_subscription':
        return await verifySubscription(req, res, data);
      case 'get_connect_status':
        return await getConnectStatus(req, res, data);
      default:
        return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (error) {
    console.error('Stripe API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

// Create $19/month creator subscription
async function createCreatorSubscription(req, res, { userId, email }) {
  try {
    // Check if user already has active subscription
    const { data: existingSub } = await supabase
      .from('creator_subscriptions')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active')
      .single();

    if (existingSub) {
      return res.status(400).json({ error: 'Already has active creator subscription' });
    }

    // Create or retrieve customer
    let customer;
    const customers = await stripe.customers.list({ email, limit: 1 });
    customer = customers.data[0];

    if (!customer) {
      customer = await stripe.customers.create({
        email,
        metadata: { userId, type: 'creator' }
      });
    }

    // Create checkout session for $19/month
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Creator Subscription',
            description: 'Monthly subscription to monetize your GPTs on the marketplace'
          },
          unit_amount: 1900, // $19.00
          recurring: { interval: 'month' }
        },
        quantity: 1
      }],
      mode: 'subscription',
      success_url: `${req.headers.origin}?creator_subscription=success`,
      cancel_url: `${req.headers.origin}?creator_subscription=cancelled`,
      metadata: { userId, type: 'creator_subscription' }
    });

    return res.json({ 
      sessionId: session.id, 
      customerId: customer.id,
      url: session.url
    });
  } catch (error) {
    console.error('Creator subscription error:', error);
    throw error;
  }
}

// Create Stripe Connect account for creator payouts
async function createConnectAccount(req, res, { userId, email }) {
  try {
    // Check if account already exists
    const { data: existingAccount } = await supabase
      .from('creator_connect_accounts')
      .select('*')
      .eq('user_id', userId)
      .single();

    let accountId = existingAccount?.stripe_account_id;

    if (!accountId) {
      // Create new Connect account
      const account = await stripe.accounts.create({
        type: 'express',
        email,
        metadata: { userId },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        }
      });

      accountId = account.id;

      // Save to database
      await supabase
        .from('creator_connect_accounts')
        .upsert({
          user_id: userId,
          stripe_account_id: accountId,
          onboarding_complete: false,
          charges_enabled: false,
          payouts_enabled: false
        });
    }

    // Create account link for onboarding
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${req.headers.origin}/creator-dashboard?setup=refresh`,
      return_url: `${req.headers.origin}?connect=success`,
      type: 'account_onboarding'
    });

    return res.json({ 
      accountId,
      onboardingUrl: accountLink.url 
    });
  } catch (error) {
    console.error('Connect account error:', error);
    throw error;
  }
}

// Create customer subscription to a specific GPT
async function createCustomerSubscription(req, res, { userId, email, gptId, creatorId, monthlyPrice }) {
  try {
    // Get creator's Connect account
    const { data: connectAccount, error: connectError } = await supabase
      .from('creator_connect_accounts')
      .select('*')
      .eq('user_id', creatorId)
      .single();

    if (connectError || !connectAccount?.onboarding_complete) {
      return res.status(400).json({ 
        error: 'Creator payment setup not complete' 
      });
    }

    // Check if customer already subscribed to this GPT
    const { data: existingSub } = await supabase
      .from('customer_subscriptions')
      .select('*')
      .eq('customer_id', userId)
      .eq('gpt_id', gptId)
      .eq('status', 'active')
      .single();

    if (existingSub) {
      return res.status(400).json({ error: 'Already subscribed to this GPT' });
    }

    // Get GPT details
    const { data: gptData, error: gptError } = await supabase
      .from('user_gpts')
      .select('*')
      .eq('id', gptId)
      .single();

    if (gptError) {
      return res.status(400).json({ error: 'GPT not found' });
    }

    // Create customer on creator's connected account
    const customer = await stripe.customers.create({
      email,
      metadata: { userId, gptId, creatorId }
    }, {
      stripeAccount: connectAccount.stripe_account_id
    });

    // Calculate application fee (30% to platform)
    const applicationFeeAmount = Math.round(monthlyPrice * 100 * 0.30);

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `GPT Access: ${gptData.gpt_data.name}`,
            description: gptData.gpt_data.description
          },
          unit_amount: Math.round(monthlyPrice * 100),
          recurring: { interval: 'month' }
        },
        quantity: 1
      }],
      mode: 'subscription',
      success_url: `${req.headers.origin}?subscription=success&gpt=${gptId}`,
      cancel_url: `${req.headers.origin}?subscription=cancelled`,
      subscription_data: {
        application_fee_percent: 30, // 30% to platform
        metadata: { userId, gptId, creatorId, type: 'customer_subscription' }
      },
      metadata: { userId, gptId, creatorId, type: 'customer_subscription' }
    }, {
      stripeAccount: connectAccount.stripe_account_id
    });

    return res.json({ 
      sessionId: session.id, 
      customerId: customer.id,
      url: session.url
    });
  } catch (error) {
    console.error('Customer subscription error:', error);
    throw error;
  }
}

// Verify subscription status
async function verifySubscription(req, res, { subscriptionId, stripeAccountId }) {
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      stripeAccount: stripeAccountId
    });

    return res.json({ 
      status: subscription.status,
      currentPeriodEnd: subscription.current_period_end,
      cancelAtPeriodEnd: subscription.cancel_at_period_end
    });
  } catch (error) {
    console.error('Verify subscription error:', error);
    throw error;
  }
}

// Get Connect account status
async function getConnectStatus(req, res, { userId }) {
  try {
    const { data: connectAccount, error } = await supabase
      .from('creator_connect_accounts')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error || !connectAccount) {
      return res.json({ exists: false });
    }

    // Get fresh status from Stripe
    const account = await stripe.accounts.retrieve(connectAccount.stripe_account_id);

    // Update database with current status
    await supabase
      .from('creator_connect_accounts')
      .update({
        onboarding_complete: account.details_submitted,
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled
      })
      .eq('user_id', userId);

    return res.json({
      exists: true,
      accountId: connectAccount.stripe_account_id,
      onboardingComplete: account.details_submitted,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled
    });
  } catch (error) {
    console.error('Get connect status error:', error);
    throw error;
  }
}
