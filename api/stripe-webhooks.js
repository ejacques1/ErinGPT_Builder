// api/stripe-webhooks.js - Handle Stripe webhook events
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Disable body parsing for webhooks
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    const body = JSON.stringify(req.body);
    event = stripe.webhooks.constructEvent(body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object);
        break;
      
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
      
      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object);
        break;
      
      case 'account.updated':
        await handleConnectAccountUpdated(event.data.object);
        break;
      
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}

async function handleCheckoutCompleted(session) {
  console.log('Checkout completed:', session.id);
  
  const { metadata, customer, subscription } = session;
  
  if (metadata.type === 'creator_subscription') {
    // Handle creator subscription
    await supabase
      .from('creator_subscriptions')
      .upsert({
        user_id: metadata.userId,
        stripe_customer_id: customer,
        stripe_subscription_id: subscription,
        status: 'active'
      });
    
    console.log('Creator subscription created for user:', metadata.userId);
  } else if (metadata.type === 'customer_subscription') {
    // Handle customer subscription to GPT
    await supabase
      .from('customer_subscriptions')
      .upsert({
        customer_id: metadata.userId,
        gpt_id: metadata.gptId,
        creator_id: metadata.creatorId,
        stripe_customer_id: customer,
        stripe_subscription_id: subscription,
        status: 'active'
      });
    
    console.log('Customer subscription created for GPT:', metadata.gptId);
  }
}

async function handleSubscriptionCreated(subscription) {
  console.log('Subscription created:', subscription.id);
  
  const { customer, status, current_period_start, current_period_end, metadata } = subscription;
  
  // Update subscription with period information
  if (metadata && metadata.type === 'creator_subscription') {
    await supabase
      .from('creator_subscriptions')
      .update({
        status,
        current_period_start: new Date(current_period_start * 1000).toISOString(),
        current_period_end: new Date(current_period_end * 1000).toISOString()
      })
      .eq('stripe_subscription_id', subscription.id);
  } else {
    // Handle customer subscriptions
    await supabase
      .from('customer_subscriptions')
      .update({
        status,
        current_period_start: new Date(current_period_start * 1000).toISOString(),
        current_period_end: new Date(current_period_end * 1000).toISOString()
      })
      .eq('stripe_subscription_id', subscription.id);
  }
}

async function handleSubscriptionUpdated(subscription) {
  console.log('Subscription updated:', subscription.id);
  
  const { status, current_period_start, current_period_end } = subscription;
  
  // Update creator subscriptions
  const { error: creatorError } = await supabase
    .from('creator_subscriptions')
    .update({
      status,
      current_period_start: new Date(current_period_start * 1000).toISOString(),
      current_period_end: new Date(current_period_end * 1000).toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('stripe_subscription_id', subscription.id);
  
  // Update customer subscriptions
  const { error: customerError } = await supabase
    .from('customer_subscriptions')
    .update({
      status,
      current_period_start: new Date(current_period_start * 1000).toISOString(),
      current_period_end: new Date(current_period_end * 1000).toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('stripe_subscription_id', subscription.id);
  
  if (creatorError && customerError) {
    console.log('Subscription not found in either table:', subscription.id);
  }
}

async function handleSubscriptionDeleted(subscription) {
  console.log('Subscription deleted:', subscription.id);
  
  // Mark subscriptions as canceled
  await supabase
    .from('creator_subscriptions')
    .update({ status: 'canceled', updated_at: new Date().toISOString() })
    .eq('stripe_subscription_id', subscription.id);
  
  await supabase
    .from('customer_subscriptions')
    .update({ status: 'canceled', updated_at: new Date().toISOString() })
    .eq('stripe_subscription_id', subscription.id);
}

async function handlePaymentFailed(invoice) {
  console.log('Payment failed for subscription:', invoice.subscription);
  
  // Mark subscriptions as past_due
  await supabase
    .from('creator_subscriptions')
    .update({ status: 'past_due', updated_at: new Date().toISOString() })
    .eq('stripe_subscription_id', invoice.subscription);
  
  await supabase
    .from('customer_subscriptions')
    .update({ status: 'past_due', updated_at: new Date().toISOString() })
    .eq('stripe_subscription_id', invoice.subscription);
}

async function handlePaymentSucceeded(invoice) {
  console.log('Payment succeeded for subscription:', invoice.subscription);
  
  // Mark subscriptions as active if they were past_due
  await supabase
    .from('creator_subscriptions')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('stripe_subscription_id', invoice.subscription);
  
  await supabase
    .from('customer_subscriptions')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('stripe_subscription_id', invoice.subscription);
}

async function handleConnectAccountUpdated(account) {
  console.log('Connect account updated:', account.id);
  
  // Update Connect account status
  await supabase
    .from('creator_connect_accounts')
    .update({
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      onboarding_complete: account.details_submitted,
      updated_at: new Date().toISOString()
    })
    .eq('stripe_account_id', account.id);
}
