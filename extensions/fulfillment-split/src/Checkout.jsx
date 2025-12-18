import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useComputed } from '@preact/signals';
import { recommendFulfillmentCount } from './utils';

// 1. Render to body
export default function extension() {
  render(<App />, document.body);
}

function App() {
  // 2. Logic & Signals
  const lines = shopify.lines.value;

  // Compute the count locally
  const logic = useComputed(() => recommendFulfillmentCount(lines));
  const fulfillmentCount = logic.value.fulfillmentCount;

  // Read current choice for UI state
  const splitMetafield = shopify.metafields.value.find(
    (m) => m.namespace === 'your_app' && m.key === 'split_choice'
  );
  const currentChoice = splitMetafield?.value;

  // 3. Conditional Rendering
  if (fulfillmentCount <= 1) {
    return null;
  }

  // 4. Handlers
  const handleChoice = async (choice) => {
    // We update TWO metafields: 
    // 1. The Yes/No choice
    // 2. The calculated count (so the backend knows the math)

    const updates = [
      {
        type: 'updateMetafield',
        namespace: 'your_app',
        key: 'split_choice',
        valueType: 'string',
        value: choice,
      },
      {
        type: 'updateMetafield',
        namespace: 'your_app',
        key: 'fulfillment_count',
        valueType: 'integer', // or 'string' if you prefer parsing later
        value: fulfillmentCount,
      }
    ];

    // Apply changes sequentially or in parallel
    for (const update of updates) {
      await shopify.applyMetafieldChange(update);
    }
  };

  // 5. Render (Using your fixed web component structure)
  return (
    <s-stack gap="base">
      <s-banner tone="info" heading="Fulfillment Options">
        <s-stack gap="base">
          <s-text>
            Your order is large enough to benefit from split shipping.
            (Calculated Parcels: {fulfillmentCount})
          </s-text>

          <s-stack gap="base" direction="inline">
            <s-button
              variant={currentChoice === 'yes' ? 'primary' : 'secondary'}
              onClick={() => handleChoice('yes')}
            >
              Yes, split shipment
            </s-button>

            <s-button
              variant={currentChoice === 'no' ? 'primary' : 'secondary'}
              onClick={() => handleChoice('no')}
            >
              No, ship together
            </s-button>
          </s-stack>
        </s-stack>
      </s-banner>
    </s-stack>
  );
}