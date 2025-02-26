'use strict';

let initiated = false;
let last = undefined;
let globalKey = 0;

// queue & timer for throttling:
let messageQueue = {};       // { authorId: payload }
let processTimer = null;
const PROCESS_DELAY = 50;    // 50ms throttle window

exports.aceInitInnerdocbodyHead = (hookName, args, cb) => {
  const url = '../static/plugins/ep_cursortrace/static/css/ace_inner.css';
  args.iframeHTML.push(`<link rel="stylesheet" type="text/css" href="${url}"/>`);
  cb();
};

exports.postAceInit = (hook_name, args, cb) => {
  initiated = true;
  cb();
};

exports.getAuthorClassName = (author) => {
  if (!author) return false;
  const authorId = author.replace(/[^a-y0-9]/g, (c) => {
    if (c === '.') return '-';
    return `z${c.charCodeAt(0)}z`;
  });
  return `ep_real_time_chat-${authorId}`;
};

exports.className2Author = (className) => {
  if (className.substring(0, 7) === 'author-') {
    return className.substring(7).replace(/[a-y0-9]+|-|z.+?z/g, (cc) => {
      if (cc === '-') {
        return '.';
      } else if (cc.charAt(0) === 'z') {
        return String.fromCharCode(Number(cc.slice(1, -1)));
      } else {
        return cc;
      }
    });
  }
};

exports.aceEditEvent = (hook_name, args) => {
  // Note: last is a tri-state: undefined (when the pad is first loaded)
  // null (no last cursor) and [line, col]
  // The AceEditEvent because it usually applies to selected items and isn't
  // really so mucha bout current position.
  const caretMoving = (
    (args.callstack.editEvent.eventType === 'handleClick') ||
    (args.callstack.type === 'handleKeyEvent') ||
    (args.callstack.type === 'idleWorkTimer')
  );

  if (caretMoving && initiated) {
    const Y = args.rep.selStart[0];
    const X = args.rep.selStart[1];
    if (!last || Y !== last[0] || X !== last[1]) { // If the position has changed
      const myAuthorId = pad.getUserId();
      const padId = pad.getPadId();
      // Create a cursor position message to send to the server
      const message = {
        type: 'cursor',
        action: 'cursorPosition',
        locationY: Y,
        locationX: X,
        padId,
        myAuthorId,
      };
      last = [Y, X];

      // console.log("Sent message", message);
      pad.collabClient.sendMessage(message);
    }
  }
  return;
};

// Throttle the handleClientMessage_CUSTOM
exports.handleClientMessage_CUSTOM = (hook, context, cb) => {
  /* I NEED A REFACTOR, please */
  // A huge problem with this is that it runs BEFORE the dom has
  // been updated so edit events are always late..
  const action = context.payload.action;
  const authorId = context.payload.authorId;
  // Dont process our own caret position (yes we do get it..) -- This is not a bug
  if (pad.getUserId() === authorId) return false;

  if (action === 'cursorPosition') {
    // Queue this author's latest cursor data
    messageQueue[authorId] = context.payload;

    // If not already scheduled, set a timer
    if (!processTimer) {
      processTimer = setTimeout(() => {
        processTimer = null;
        processQueuedMessages();
      }, PROCESS_DELAY);
    }
  }

  return cb();
};

// Process messages in bulk
function processQueuedMessages() {
  const queued = { ...messageQueue };
  messageQueue = {}; // clear the queue

  // For each author in the queue, run the DOM logic
  Object.keys(queued).forEach((authorId) => {
    const payload = queued[authorId];
    if (!payload) return;

    const authorClass = exports.getAuthorClassName(authorId);

    let authorName = payload.authorName;
    if (authorName === 'null' || authorName == null) {
      // If the users username isn't set then display a smiley face
      authorName = '😊';
    }
    // +1 as Etherpad line numbers start at 1
    const y = payload.locationY + 1;
    let x = payload.locationX - 1;

    const inner = $('iframe[name="ace_outer"]').contents().find('iframe');
    let leftOffset;
    if (inner.length !== 0) {
      leftOffset = parseInt($(inner).offset().left) || 0;
      leftOffset += parseInt($(inner).css('padding-left')) || 0;
    }

    let stickStyle = 'stickDown';

    // Get the target line
    const div = $('iframe[name="ace_outer"]').contents()
      .find('iframe').contents().find('#innerdocbody')
      .find(`div:nth-child(${y})`);

    // Is the line visible yet?
    if (div.length !== 0) {
      const divWidth = div.width();
      const divLineHeight = parseInt(getComputedStyle(div.get(0)).lineHeight);
      let top = parseInt($(div).offset().top) || 0; // A standard generic offset
      // The problem we have here is we don't know the px X offset of the caret from the user
      // Because that's a blocker for now lets just put a nice little div on the left hand side..
      // SO here is how we do this..
      // Get the entire string including the styling
      // Put it in a hidden SPAN that has the same width as ace inner
      // Delete everything after X chars
      // Measure the new width -- This gives us the offset without modifying the ACE Dom
      // Due to IE sucking this doesn't work in IE....
      // We need the offset of the innerdocbody on top too.
      top += parseInt($('iframe[name="ace_outer"]').contents()
        .find('iframe').css('paddingTop')) || 0;
      // and the offset of the outerdocbody too. (for wide/narrow screens compatibility)
      top += parseInt($('iframe[name="ace_outer"]').contents().find('#outerdocbody')
        .css('padding-top')) - 10;

      // Get the HTML, appending a dummy span to express the end of the line
      const html = $(div).html() + `<span>&#xFFEF;</span>`;

      // build an ugly ID, makes sense to use authorId as authorId's cursor can only exist once
      const authorWorker = `hiddenUgly${exports.getAuthorClassName(authorId)}`;

      // if Div contains block attribute IE h1 or H2 then increment by the number
      // This is horrible but a limitation because I'm parsing HTML
      if ($(div).children('span').length < 1) {
        x -= 1;
      }

      // Get the new string but maintain mark up
      const newText = html_substr(html, x);

      // Insert a hidden measuring element
      // A load of ugly HTML that can prolly be moved to CSS
      const newLine = `<span style='width:${divWidth}px; ; line-height:${divLineHeight}px;'
        id='${authorWorker}' class='ghettoCursorXPos'>${newText}</span>`;

      // Set the globalKey to 0, we use this when we wrap the objects in a datakey
      globalKey = 0; // It's bad, messy, don't ever develop like this.

      // Add the HTML to the DOM
      $('iframe[name="ace_outer"]').contents().find('#outerdocbody').append(newLine);

      // Get the worker element
      const worker = $('iframe[name="ace_outer"]').contents()
        .find('#outerdocbody').find(`#${authorWorker}`);
      // Wrap the HTML in spans so we can find a char
      $(worker).html(wrap($(worker)));
      // console.log($(worker).html(), x);

      // Copy relevant CSS from the line to match fonts
      const lineStyles = window.getComputedStyle(div[0]);
      worker.css({
        'font-size': lineStyles.fontSize,
        'font-family': lineStyles.fontFamily,
        'line-height': lineStyles.lineHeight,
        'white-space': lineStyles.whiteSpace,
        'font-weight': lineStyles.fontWeight,
        'letter-spacing': lineStyles.letterSpacing,
      });

      // Get the Left offset of the x span
      const span = $(worker).find(`[data-key="${x - 1}"]`);

      // Get the width of the element (This is how far out X is in px);
      let left = 0;
      if (span.length !== 0) {
        left = span.position().left;
      } else {
        // empty span.
        left = 0;
      }

      // Get the height of the element minus the inner line height
      const height = worker.height(); // the height of the worker
      top = top + height - (span.height() || 12);
      // plus the top offset minus the actual height of our focus span
      if (top <= 0) { // If the tooltip wont be visible to the user because it's too high up
        stickStyle = 'stickUp';
        top += (span.height() || 12) * 2;
        if (top < 0) top = 0; // handle case where caret is in 0,0
      }

      // Add the innerdocbody offset
      left += leftOffset || 0;

      // Add support for page view margins
      let divMargin = parseInt($(div).css('margin-left')) || 0;
      let innerdocbodyMargin = parseInt($(div).parent().css('padding-left')) || 0;
      left += (divMargin + innerdocbodyMargin);
      left += 18;

      // Remove the element
      $('iframe[name="ace_outer"]').contents().find('#outerdocbody')
        .contents().remove(`#${authorWorker}`);

      // Author color
      const users = pad.collabClient.getConnectedUsers();
      $.each(users, (user, value) => {
        if (value.userId === authorId) {
          const colors = pad.getColorPalette(); // support non set colors
          let color;
          if (colors[value.colorId]) {
            color = colors[value.colorId];
          } else {
            color = value.colorId; // Test for XSS
          }
          const outBody = $('iframe[name="ace_outer"]').contents().find('#outerdocbody');

          // Remove all divs that already exist for this author
          $('iframe[name="ace_outer"]').contents().find(`.caret-${authorClass}`).remove();


          // Create a new Div for this author
          const $indicator = $(`<div class='caretindicator caret-${authorClass}'
            style='height:16px; background-color:${color}'>
            </div>`);
          const $paragraphName = $(`<p class='stickp'>${authorName}</p>`);

          //First insert elements into page to be able to use their widths to calculate when to switch stick to right
          $indicator.append($paragraphName);
          $(outBody).append($indicator);

          const absolutePositionOfPageEnd = div.offset().left + div.width() + leftOffset + 2 * divMargin;
          if (left > (absolutePositionOfPageEnd - $indicator.width())) {
            stickStyle = 'stickRight';
            left = left - $indicator.width();
          }
          $indicator.addClass(`${stickStyle}`);
          $paragraphName.addClass(`${stickStyle}`);
          $indicator.css('left', `${left}px`);
          $indicator.css('top', `${top}px`);
          $indicator.attr('title', authorName);

          // After a while, fade it out :)
          setTimeout(() => {
            $indicator.fadeOut(500, () => {
              $indicator.remove();
            });
          }, 2000);
        }
      });
    }
  });
}

const html_substr = (str, count) => {
  const div = document.createElement('div');
  div.innerHTML = str;

  const track = (el) => {
    if (count > 0) {
      const len = el.data.length;
      count -= len;
      if (count <= 0) {
        el.data = el.substringData(0, el.data.length + count);
      }
    } else {
      el.data = '';
    }
  };

  const walk = (el, fn) => {
    let node = el.firstChild;
    if (!node) return;
    do {
      if (node.nodeType === 3) {
        fn(node);
        //          Added this >>------------------------------------<<
      } else if (node.nodeType === 1 && node.childNodes && node.childNodes[0]) {
        walk(node, fn);
      }
    } while ((node = node.nextSibling)); /* eslint-disable-line no-cond-assign */
  };
  walk(div, track);
  return div.innerHTML;
};

const wrap = (target) => {
  const newtarget = $('<div></div>');
  const nodes = target.contents().clone(); // the clone is critical!
  if (!nodes) return;
  nodes.each(function () {
    if (this.nodeType === 3) { // text
      let newhtml = '';
      const text = this.wholeText; // maybe "textContent" is better?
      for (let i = 0; i < text.length; i++) {
        if (text[i] === ' ') {
          newhtml += `<span data-key=${globalKey}> </span>`;
        } else {
          newhtml += `<span data-key=${globalKey}>${text[i]}</span>`;
        }
        globalKey++;
      }
      newtarget.append($(newhtml));
    } else { // recursion FTW!
      // console.log("recursion"); // IE handles recursion badly
      $(this).html(wrap($(this))); // This really hurts doing any sort of count..
      newtarget.append($(this));
    }
  });
  return newtarget.html();
};
