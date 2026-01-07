import type { BackgroundRequest, ProviderRequest, ProviderResponse } from './shared/types'

const INJECTED_ID = 'tempo-wallet-injected'

function injectProvider(): void {
  if (document.getElementById(INJECTED_ID)) return
  const script = document.createElement('script')
  script.id = INJECTED_ID
  script.src = chrome.runtime.getURL('injected_provider.js')
  script.type = 'module'
  document.documentElement.appendChild(script)
  script.onload = () => script.remove()
}

injectProvider()

window.addEventListener('message', async (event: MessageEvent) => {
  if (event.source !== window) return
  if (!event.data || event.data.type !== 'TEMPO_PROVIDER_REQUEST') return

  const request = event.data.payload as ProviderRequest
  const message: BackgroundRequest = {
    type: 'PROVIDER_REQUEST',
    payload: {
      ...request,
      origin: window.location.origin
    }
  }

  const response = await chrome.runtime.sendMessage(message)
  const payload = response as ProviderResponse

  window.postMessage(
    {
      type: 'TEMPO_PROVIDER_RESPONSE',
      payload
    },
    '*'
  )
})
