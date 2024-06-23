import { Message, NUMBER_OF_LITERALS, StoredConfig } from "./constants"
import Optimizer from "./optimizer"

const blurFilter = "blur(0.343em)" // This unique filter value identifies the OpenBlur filter.
const tagsNotToBlur = ["HEAD", "SCRIPT", "STYLE", "loc"]

const contentToBlur: string[] = []
let enabled = true
let bodyHidden = true
let doFullScan = false

// Performance optimization. The performance optimization mode is enabled when we blur a lot of elements in a short period of time.
const maxBlursCount = 100
let blursCount = maxBlursCount
const performanceOptimizationResetMs = 5 * 1000
let performanceOptimizationMode = false

console.debug("OpenBlur content script loaded")

function unhideBody(force?: boolean) {
  if (bodyHidden || force) {
    const message: Message = { action: "unhideBody" }
    void chrome.runtime.sendMessage(message)
    bodyHidden = false
  }
}

function processInputElement(
  input: HTMLInputElement | HTMLTextAreaElement,
  blurredElements: Set<HTMLElement>,
) {
  let blurTarget: HTMLElement = input
  if (
    performanceOptimizationMode &&
    input.parentElement instanceof HTMLElement
  ) {
    // In performance optimization mode, we may blur the parent.
    const grandParent = input.parentElement
    if (grandParent.style.filter.includes(blurFilter)) {
      // Treat the grandparent as the parent.
      blurTarget = grandParent
    }
  }
  if (blurredElements.has(blurTarget)) {
    // This element has already been blurred in this pass
    return
  }
  const text = (input.value || input.getAttribute("value")) ?? ""
  if (blurTarget.style.filter.includes(blurFilter)) {
    // Already blurred
    if (!enabled) {
      // We remove the blur filter if the extension is disabled.
      unblurElement(blurTarget)
      return
    }
    const blurNeeded = contentToBlur.some((content) => {
      return text.includes(content)
    })
    if (!blurNeeded) {
      unblurElement(blurTarget)
    } else {
      blurredElements.add(blurTarget)
    }
    return
  } else if (enabled && text.length > 0) {
    const blurNeeded = contentToBlur.some((content) => {
      return text.includes(content)
    })
    if (blurNeeded) {
      blurredElements.add(blurElement(blurTarget))
    }
  }
}

function processNodeWithParent(node: Node) {
  let target = node
  if (performanceOptimizationMode && target.parentElement) {
    // We must consider the parent/grandparent in performance optimization mode.
    if (
      node.nodeType === Node.TEXT_NODE &&
      target.parentElement.parentElement
    ) {
      // We must consider the grandparent for text nodes.
      target = target.parentElement.parentElement
    } else {
      target = target.parentElement
    }
  }
  processNode(target, new Set<HTMLElement>())
}

function processHtmlElement(
  parent: HTMLElement | null,
  text: string,
  blurredElements: Set<HTMLElement>,
  checkContent: boolean,
) {
  if (parent?.style) {
    let useGrandParent = false
    if (
      performanceOptimizationMode &&
      parent.parentElement instanceof HTMLElement
    ) {
      // In performance optimization mode, we may blur the parent's parent.
      const grandParent = parent.parentElement
      if (grandParent.style.filter.includes(blurFilter)) {
        // Treat the grandparent as the parent.
        parent = grandParent
        useGrandParent = true
      }
    }
    if (blurredElements.has(parent)) {
      // This element has already been blurred in this pass.
      return
    }
    if (parent.style.filter.includes(blurFilter)) {
      // Already blurred
      if (!enabled) {
        // We remove the blur filter if the extension is disabled.
        unblurElement(parent)
        return
      }
      // In performance optimization mode, the grandparent may have been updated to have
      // completely different content.
      if (checkContent || useGrandParent) {
        // Double check if the blur is still needed.
        const blurNeeded = contentToBlur.some((content) => {
          return text.includes(content)
        })
        if (!blurNeeded) {
          unblurElement(parent)
        } else {
          blurredElements.add(parent)
        }
      }
      return
    } else if (enabled) {
      const blurNeeded = contentToBlur.some((content) => {
        return text.includes(content)
      })
      if (blurNeeded) {
        blurredElements.add(blurElement(parent))
      }
    }
  }
}

function processNode(node: Node, blurredElements: Set<HTMLElement>) {
  if (node instanceof HTMLElement && tagsNotToBlur.includes(node.tagName)) {
    return
  }
  if (
    node.nodeType === Node.TEXT_NODE &&
    node.textContent !== null &&
    node.textContent.trim().length > 0
  ) {
    const text = node.textContent
    processHtmlElement(node.parentElement, text, blurredElements, doFullScan)
  } else if (node.nodeType === Node.ELEMENT_NODE) {
    const elem = node as HTMLElement
    switch (elem.tagName) {
      case "INPUT": {
        const input = elem as HTMLInputElement
        if (input.type === "text") {
          processInputElement(input, blurredElements)
          input.addEventListener("input", inputEventListener)
        }
        break
      }
      case "TEXTAREA": {
        const textarea = elem as HTMLTextAreaElement
        processInputElement(textarea, blurredElements)
        textarea.addEventListener("input", inputEventListener)
        break
      }
      case "SELECT": {
        const select = elem as HTMLSelectElement
        const text = select.options[select.selectedIndex].text
        processHtmlElement(select, text, blurredElements, true)
        select.addEventListener("change", selectOnChangeListener)
        break
      }
      default: {
        if (node.childNodes.length > 0) {
          Array.from(node.childNodes).forEach((value) => {
            processNode(value, blurredElements)
          })
        }
      }
    }
  } else {
    if (node.childNodes.length > 0) {
      Array.from(node.childNodes).forEach((value) => {
        processNode(value, blurredElements)
      })
    }
  }
}

// The blurStyleObserver is used to reapply the blur filter if it is removed.
// The style changes should not be common.
const blurStyleObserver = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    if (mutation.type === "attributes") {
      processNodeWithParent(mutation.target)
    }
  })
})

function blurElement(elem: HTMLElement): HTMLElement {
  let blurTarget: HTMLElement = elem
  if (performanceOptimizationMode) {
    const ok = Optimizer.addElement(elem)
    if (!ok && elem.parentElement) {
      blurTarget = elem.parentElement
      void Optimizer.addElement(elem)
    }
  }
  if (blurTarget.style.filter.length == 0) {
    blurTarget.style.filter = blurFilter
  } else {
    // The element already has a filter. Append our blur filter to the existing filter.
    // We assume that the semicolon(;) is never present in the filter string. This has been the case in our limited testing.
    blurTarget.style.filter += ` ${blurFilter}`
  }
  // Note: observing the same element multiple times is a no-op.
  blurStyleObserver.observe(elem, {
    attributes: true,
    attributeFilter: ["style"],
  })
  if (blurTarget === elem) {
    console.debug(
      "OpenBlur blurred element id:%s, class:%s, tag:%s, text:%s",
      elem.id,
      elem.className,
      elem.tagName,
      elem.textContent,
    )
  } else {
    console.debug(
      "OpenBlur blurred parent element id:%s, class:%s, tag:%s, elementText:%s",
      blurTarget.id,
      blurTarget.className,
      blurTarget.tagName,
      elem.textContent,
    )
  }
  blursCount--
  if (blursCount <= 0) {
    if (!performanceOptimizationMode) {
      console.debug("OpenBlur performance optimization mode enabled")
      performanceOptimizationMode = true
    }
  }
  return blurTarget
}

function unblurElement(elem: HTMLElement) {
  elem.style.filter = elem.style.filter.replace(blurFilter, "")
  if (performanceOptimizationMode) {
    Optimizer.removeElement(elem)
  }
  console.debug(
    "OpenBlur unblurred element id:%s, class:%s, tag:%s, text:%s",
    elem.id,
    elem.className,
    elem.tagName,
    elem.textContent,
  )
}

const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    if (mutation.addedNodes.length > 0) {
      mutation.addedNodes.forEach((node) => {
        processNodeWithParent(node)
      })
    } else {
      processNodeWithParent(mutation.target)
    }
  })
})

function inputEventListener(event: Event) {
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement
  ) {
    processInputElement(event.target, new Set<HTMLElement>())
  }
}

function selectOnChangeListener(event: Event) {
  if (event.target instanceof HTMLSelectElement) {
    const select = event.target
    const text = select.options[select.selectedIndex].text
    processHtmlElement(select, text, new Set<HTMLElement>(), true)
  }
}

function observe() {
  observer.observe(document, {
    attributes: false,
    characterData: true,
    childList: true,
    subtree: true,
  })

  // Loop through all elements on the page.
  processNode(document, new Set<HTMLElement>())
}

function disconnectInputs() {
  const inputs = document.getElementsByTagName("INPUT")
  for (const input of inputs) {
    input.removeEventListener("input", inputEventListener)
  }
}

function disconnect() {
  observer.disconnect()
  blurStyleObserver.disconnect()
  disconnectInputs()
}

function setLiterals(literals: string[]) {
  contentToBlur.length = 0
  for (let i = 0; i < NUMBER_OF_LITERALS; i++) {
    const item: string = literals[i]
    if (item && item.trim().length > 0) {
      contentToBlur.push(item.trim())
    }
  }
  if (enabled) {
    doFullScan = true
    observe()
    doFullScan = false
  }
  unhideBody()
}

chrome.storage.sync.get(null, (data) => {
  const config = data as StoredConfig
  if (config.mode?.id === "off") {
    enabled = false
  }
  const literals: string[] = config.literals ?? []
  setLiterals(literals)
})

function handleMessage(request: unknown) {
  console.debug("OpenBlur received message from popup", request)
  const message = request as Message

  if (message.mode) {
    if (message.mode.id === "off") {
      enabled = false
      disconnect()
      processNode(document, new Set<HTMLElement>())
      if (performanceOptimizationMode) {
        Optimizer.clear()
        performanceOptimizationMode = false
      }
    } else {
      enabled = true
      observe()
    }
  }
  if (message.literals) {
    setLiterals(message.literals)
  }
}

// Listen for messages from popup.
chrome.runtime.onMessage.addListener(handleMessage)

setInterval(() => {
  blursCount = maxBlursCount
}, performanceOptimizationResetMs)

// Page lifecycle events. Used for back/forward navigation.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    // The page was restored from the browser cache.
    // We need to reconnect the extension listener.
    chrome.runtime.onMessage.addListener(handleMessage)
    unhideBody(true)
  }
})

window.addEventListener("pagehide", (event) => {
  if (event.persisted) {
    // The page is being saved into the browser cache.
    // We need to disconnect the extension listener.
    chrome.runtime.onMessage.removeListener(handleMessage)
  }
})
