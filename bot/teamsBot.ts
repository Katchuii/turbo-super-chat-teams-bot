import {
  TeamsActivityHandler,
  TurnContext,
  SigninStateVerificationQuery,
  BotState,
  AdaptiveCardInvokeValue,
  AdaptiveCardInvokeResponse,
  MemoryStorage,
  ConversationState,
  UserState,
} from 'botbuilder';
import { Utils } from './helpers/utils';
import { SSODialog } from './helpers/ssoDialog';
import { CommandsHelper } from './helpers/commandHelper';
import {
  Configuration,
  OpenAIApi,
  ChatCompletionRequestMessageRoleEnum,
} from 'azure-openai';
const rawWelcomeCard = require('./adaptiveCards/welcome.json');
const rawLearnCard = require('./adaptiveCards/learn.json');

export class TeamsBot extends TeamsActivityHandler {
  likeCountObj: { likeCount: number };
  conversationState: BotState;
  userState: BotState;
  dialog: SSODialog;
  dialogState: any;
  //commandsHelper: CommandsHelper;
  openAiApi: OpenAIApi;
  temperature: number;
  aoaiModel: string;
  chatGptSystemContent: string;
  chatGptMaxToken: number;
  chatGptTopP: number;

  constructor() {
    super();

    // record the likeCount
    this.likeCountObj = { likeCount: 0 };

    // Define the state store for your bot.
    // See https://aka.ms/about-bot-state to learn more about using MemoryStorage.
    // A bot requires a state storage system to persist the dialog and user state between messages.
    const memoryStorage = new MemoryStorage();

    // Create conversation and user state with in-memory storage provider.
    this.conversationState = new ConversationState(memoryStorage);
    this.userState = new UserState(memoryStorage);
    this.dialog = new SSODialog(new MemoryStorage());
    this.dialogState = this.conversationState.createProperty('DialogState');

    this.temperature = parseInt(process.env.CHATGPT_TEMPERATURE);
    this.aoaiModel = process.env.AOAI_MODEL;
    this.chatGptSystemContent = process.env.CHATGPT_SYSTEMCONTENT;
    this.chatGptMaxToken = parseInt(process.env.CHATGPT_MAXTOKEN);
    this.chatGptTopP = parseInt(process.env.CHATGPT_TOPP);

    this.openAiApi = new OpenAIApi(
      new Configuration({
        apiKey: process.env.AOAI_APIKEY,
        // add azure info into configuration
        azure: {
          apiKey: process.env.AOAI_APIKEY,
          endpoint: process.env.AOAI_ENDPOINT,
          // deploymentName is optional, if you do not set it, you need to set it in the request parameter
          deploymentName: process.env.AOAI_MODEL,
        },
      })
    );

    this.onMessage(async (context, next) => {
      console.log('Running with Message Activity.');

      let txt = context.activity.text;
      // remove the mention of this bot
      const removedMentionText = TurnContext.removeRecipientMention(
        context.activity
      );
      if (removedMentionText) {
        // Remove the line break
        txt = removedMentionText.toLowerCase().replace(/\n|\r/g, '').trim();
      }

      if (txt.startsWith('/set temperature')) {
      }

      let revisedprompt = [
        {
          role: ChatCompletionRequestMessageRoleEnum.System,
          content: this.chatGptSystemContent,
        },
        { role: ChatCompletionRequestMessageRoleEnum.User, content: txt },
      ];
      console.log(
        'createChatCompletion request: ' +
          JSON.stringify(revisedprompt[1].content)
      );
      try {
        const prompt = JSON.stringify(revisedprompt[1].content);

        let completion;

        if (prompt.includes('/set')) {

          console.log('set new temperature!');
          const regex = /(\d+\.\d+)/; // Regular expression to match a decimal number
          const match = prompt.match(regex);
          const temperature = parseFloat(match[0]);
          console.log('TEMPERATURE', temperature);
          
          this.temperature = temperature;

          await context.sendActivity(`you set a new temperature of ${temperature}. you can now continue with your regular prompting`);

        } else {
          completion = await this.openAiApi.createChatCompletion({
            model: this.aoaiModel,
            messages: revisedprompt,
            temperature: this.temperature,
            max_tokens: this.chatGptMaxToken,
            top_p: this.chatGptMaxToken,
            stop: process.env.CHATGPT_STOPSEQ,
          });

          console.log(
            'createChatCompletion response: ' +
              completion.data.choices[0].message.content
          );

          console.log('current tempperature is: ', this.temperature);

          await context.sendActivity(completion.data.choices[0].message.content);
        }

       
        
      } catch (error) {
        if (error.response) {
          console.log(error.response.status);
          console.log(error.response.data);
        } else {
          console.log(error.message);
        }
      }

      // Trigger command by IM text
      await CommandsHelper.triggerCommand(txt, {
        context: context,
        ssoDialog: this.dialog,
        dialogState: this.dialogState,
        likeCount: this.likeCountObj,
      });

      // By calling next() you ensure that the next BotHandler is run.
      await next();
    });

    this.onMembersAdded(async (context, next) => {
      const membersAdded = context.activity.membersAdded;
      for (let cnt = 0; cnt < membersAdded.length; cnt++) {
        if (membersAdded[cnt].id) {
          //          const card = Utils.renderAdaptiveCard(rawWelcomeCard);
          //          await context.sendActivity({ attachments: [card] });
          await context.sendActivity(
            'Hello, thank you for using TeamsGPT bot, please send question with mention @TeamsGPT if in group chat.'
          );
          break;
        }
      }
      await next();
    });
  }
  

  // Invoked when an action is taken on an Adaptive Card. The Adaptive Card sends an event to the Bot and this
  // method handles that event.
  async onAdaptiveCardInvoke(
    context: TurnContext,
    invokeValue: AdaptiveCardInvokeValue
  ): Promise<AdaptiveCardInvokeResponse> {
    // The verb "userlike" is sent from the Adaptive Card defined in adaptiveCards/learn.json
    if (invokeValue.action.verb === 'userlike') {
      this.likeCountObj.likeCount++;
      const card = Utils.renderAdaptiveCard(rawLearnCard, this.likeCountObj);
      await context.updateActivity({
        type: 'message',
        id: context.activity.replyToId,
        attachments: [card],
      });
      return { statusCode: 200, type: undefined, value: undefined };
    }
  }

  async run(context: TurnContext) {
    await super.run(context);

    // Save any state changes. The load happened during the execution of the Dialog.
    await this.conversationState.saveChanges(context, false);
    await this.userState.saveChanges(context, false);
  }

  async handleTeamsSigninVerifyState(
    context: TurnContext,
    query: SigninStateVerificationQuery
  ) {
    console.log(
      'Running dialog with signin/verifystate from an Invoke Activity.'
    );
    await this.dialog.run(context, this.dialogState);
  }

  async handleTeamsSigninTokenExchange(
    context: TurnContext,
    query: SigninStateVerificationQuery
  ) {
    await this.dialog.run(context, this.dialogState);
  }

  async onSignInInvoke(context: TurnContext) {
    await this.dialog.run(context, this.dialogState);
  }
}
