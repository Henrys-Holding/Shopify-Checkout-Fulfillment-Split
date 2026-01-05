import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks'; // Import useState and useEffect
import { getFulfillmentCap, getParcelPriceByShippingLineTitle, getShippingLineLevel, recommendFulfillmentCount } from './utils';
import { useBuyerJourneyIntercept, useDeliveryGroup } from '@shopify/ui-extensions/checkout/preact';

export default function extension() {
  render(<App />, document.body);
}

function App() {
  // --- 1. State Management ---
  // We store the calculation results in local state
  const [calculation, setCalculation] = useState({
    fulfillmentCount: 0,
    parcelPrice: 0,
    isValid: false
  });

  // --- 2. Read Signals ---
  // Accessing .value here subscribes the component to updates.
  // When Shopify updates these signals, the component re-renders.
  const lines = shopify.lines.value;
  const address = shopify.shippingAddress.value;
  const deliveryGroups = shopify.deliveryGroups.value;
  const attributes = shopify.attributes.value;
  // Access Shopify's global i18n object
  const i18n = shopify.i18n;
  const translate = (key, replacements) => i18n.translate(key, replacements);


  // Extract specific dependencies for the Effect
  const countryCode = address?.countryCode;

  // Safely get the selected delivery option title
  const firstDeliveryGroup = useDeliveryGroup(deliveryGroups[0]);
  const selectedDeliveryOption = firstDeliveryGroup?.selectedDeliveryOption;
  const deliveryTitle = selectedDeliveryOption?.title;

  // --- 3. The Recalculation Effect ---
  // This runs whenever countryCode, lines, or deliveryTitle changes.
  useEffect(() => {
    // A. Early Exit if data is missing
    if (!countryCode || !lines || !deliveryTitle) {
      setCalculation({ fulfillmentCount: 0, parcelPrice: 0, isValid: false });
      return;
    }

    // B. Check Supported Countries
    const isSupportedCountry = ['CN', 'HK', 'TW'].includes(countryCode);
    if (!isSupportedCountry) {
      setCalculation({ fulfillmentCount: 0, parcelPrice: 0, isValid: false });
      return;
    }

    // C. Get Constants based on inputs
    const shippingLevel = getShippingLineLevel(deliveryTitle, countryCode);
    const price = getParcelPriceByShippingLineTitle(deliveryTitle, countryCode);
    const cap = getFulfillmentCap(countryCode);

    if (!shippingLevel || !price) {
      setCalculation({ fulfillmentCount: 0, parcelPrice: 0, isValid: false });
      return;
    }

    // D. Run the Algorithm
    const result = recommendFulfillmentCount(lines, { cap });

    // E. Update State
    setCalculation({
      fulfillmentCount: result.fulfillmentCount,
      parcelPrice: price,
      isValid: true
    });

  }, [countryCode, lines, deliveryTitle]); // <--- DEPENDENCY ARRAY is key

  // --- 4. Read Current User Choice ---
  const splitMetafield = attributes.find((m) => m.key === 'split_choice');
  const currentChoice = splitMetafield?.value;

  // Destructure state
  const { fulfillmentCount, parcelPrice, isValid } = calculation;
  const totalParcelPrice = (parcelPrice || 0) * (fulfillmentCount - 1);
  const formattedPrice = totalParcelPrice.toFixed(2);

  // --- 5. Hiding & Cleanup Logic ---
  const isCountTooLow = fulfillmentCount <= 1;
  const shouldHide = !isValid || isCountTooLow;

  useEffect(() => {
    // Clean up if context becomes invalid while a choice exists
    if (shouldHide && currentChoice) {
      console.log('Context Invalid. Cleaning up attributes...');
      const cleanUp = async () => {
        await shopify.applyAttributeChange({ type: 'removeAttribute', key: 'split_choice' });
        await shopify.applyAttributeChange({ type: 'removeAttribute', key: 'split_fulfillment_count' });
      };
      cleanUp();
    }
  }, [shouldHide, currentChoice]);

  // --- 6. Intercept Logic ---
  useBuyerJourneyIntercept(({ canBlockProgress }) => {
    // If we are hidden, we should NEVER block.
    if (shouldHide) return { behavior: 'allow' };

    if (canBlockProgress && !currentChoice) {
      return {
        behavior: 'block',
        reason: translate('errors.selection_required'),
        errors: [{ message: translate('errors.selection_required') }],
      };
    }
    return { behavior: 'allow' };
  });

  // --- 7. Render UI ---
  if (shouldHide) return null;

  const handleChoice = async (choice) => {
    const updates = [
      { type: 'updateAttribute', key: 'split_choice', value: choice },
      { type: 'updateAttribute', key: 'split_fulfillment_count', value: fulfillmentCount.toString() }
    ];
    for (const update of updates) await shopify.applyAttributeChange(update);
  };

  return (
    <s-stack gap="base" border="base" padding="base" border-radius="base">
      <s-stack gap="none">
        <s-text type="strong" tone="critical">
          {translate('split_proposal.title', {
            count: fulfillmentCount,
            amount: formattedPrice
          })}
        </s-text>
        <s-text>
          {translate('split_proposal.description', {
            count: fulfillmentCount
          })}
        </s-text>
      </s-stack>

      <s-stack direction="inline" gap="small-300">
        <s-button
          variant={currentChoice === 'yes' ? 'primary' : 'secondary'}
          onClick={() => handleChoice('yes')}
        >
          {translate('split_proposal.buttons.agree')}
        </s-button>

        <s-button
          variant={currentChoice === 'no' ? 'primary' : 'secondary'}
          onClick={() => handleChoice('no')}
        >
          {translate('split_proposal.buttons.refuse')}
        </s-button>
      </s-stack>

      {currentChoice === 'yes' && (
        <s-banner tone="info">
          {translate('split_confirmation.agreed', {
            amount: formattedPrice
          })}
        </s-banner>
      )}

      {currentChoice === 'no' && (
        <s-banner tone="critical">
          <s-stack gap="small-300">
            <s-text type="strong">{translate('split_confirmation.refused.title')}</s-text>
            <s-text>{translate('split_confirmation.refused.risk_limit')}</s-text>
            <s-text>{translate('split_confirmation.refused.risk_return')}</s-text>
          </s-stack>
        </s-banner>
      )}
    </s-stack>
  );
}